/**
 * ESP32Tool NVS (Non-Volatile Storage) Editor
 *
 * A full-screen editor for viewing and editing NVS partition contents.
 * Features:
 *   - Parse and display NVS pages, namespaces and key/value entries
 *   - Inline editing of values (primitives, strings, blobs)
 *   - Delete entries
 *   - Add new entries and namespaces
 *   - Write modified NVS data back to flash
 *   - Filter / search entries
 *   - Page state indicator
 */

import { HexEditor } from './hex-editor.js';

export class NVSEditor {
  /**
   * @param {HTMLElement} container - The container element (#nvseditor-container)
   */
  constructor(container) {
    this.container = container;
    /** @type {Uint8Array|null} raw NVS partition data */
    this.data = null;
    /** @type {Uint8Array|null} original snapshot for diff */
    this.originalData = null;
    this.baseAddress = 0;        // flash offset of the NVS partition
    this.partitionSize = 0;
    this.partitionName = '';

    /** Parsed pages with items */
    this.pages = [];
    /** Whether data has been modified */
    this.modified = false;

    // Callbacks
    this.onClose = null;
    /** @type {((data: Uint8Array) => Promise<void>)|null} */
    this.onWriteFlash = null;

    // DOM cache
    this._progressOverlay = null;
    this._progressText = null;
    this._progressBarInner = null;

    // Filter state
    this._filterText = '';

    // Sub hex-editor for large entries
    this._hexEditorInstance = null;
    this._hexEditorContainer = null;
  }

  // ─────── CRC32 helpers (same as esp32-parser NVSParser) ───────

  static crc32Byte(crc, d) {
    for (let i = 0; i < 8; i++) {
      const bit = d & 1;
      crc ^= bit;
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
      d >>>= 1;
    }
    return crc >>> 0;
  }

  static crc32(data, offset = 0, length = null) {
    let crc = 0;
    const len = length ?? data.length - offset;
    for (let i = 0; i < len; i++) {
      crc = NVSEditor.crc32Byte(crc, data[offset + i]);
    }
    return (~crc) >>> 0;
  }

  static crc32Header(data, offset = 0) {
    const buf = new Uint8Array(0x20 - 4);
    buf.set(data.subarray(offset, offset + 4), 0);
    buf.set(data.subarray(offset + 8, offset + 8 + 0x18), 4);
    return NVSEditor.crc32(buf, 0, 0x1C);
  }

  static bytesToHex(bytes, separator = '') {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(separator);
  }

  // ─────── Blob helpers (from Berry nvs.be) ───────

  static isBlob(item) {
    const t = item.typeName;
    return item.datatype === 0x42 || item.datatype === 0x48;
  }

  static isBlobData(item) {
    return item.datatype === 0x42;
  }

  static blobKey(item) {
    return item.key;
  }

  static blobTotalSize(item) {
    if (item.datatype === 0x48 && item.totalSize !== undefined) {
      return item.totalSize;
    }
    if (item.datatype === 0x42 && item.size !== undefined) {
      return item.size;
    }
    return 0;
  }

  static blobExpectedChunks(item) {
    if (item.datatype === 0x48 && item.chunkCount !== undefined) {
      return item.chunkCount;
    }
    return 0;
  }

  // ─────── Hex dump function (from Berry nvs.be) ───────

  static hexDump(data, offset = 0) {
    const width = 16;
    let result = '';
    
    for (let i = 0; i < data.length; i += width) {
      const lineOffset = offset + i;
      const hexLine = [];
      const asciiLine = [];
      
      for (let j = 0; j < width; j++) {
        if (i + j < data.length) {
          const byte = data[i + j];
          hexLine.push(byte.toString(16).padStart(2, '0').toUpperCase());
          asciiLine.push((byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.');
        } else {
          hexLine.push('  ');
          asciiLine.push(' ');
        }
      }
      
      result += `${lineOffset.toString(16).padStart(6, '0').toUpperCase()}  ${hexLine.join(' ')}\t ${asciiLine.join('')}\n`;
    }
    
    return result;
  }

  // ─────── Integrity checking and statistics (from Berry nvs.be) ───────

  getStatistics() {
    const stats = {
      pages_total: this.pages.length,
      pages_active: 0,
      pages_full: 0,
      pages_empty: 0,
      pages_freeing: 0,
      pages_corrupted: 0,
      pages_bad_header_crc: 0,
      entries_written: 0,
      entries_erased: 0,
      entries_empty: 0,
      entries_bad_header_crc: 0,
      entries_bad_data_crc: 0,
      blobs_complete: 0,
      blobs_incomplete: 0
    };

    for (const page of this.pages) {
      stats.pages_total++;
      
      if (page.state === 'ACTIVE') stats.pages_active++;
      else if (page.state === 'FULL') stats.pages_full++;
      else if (page.state === 'UNINIT') stats.pages_empty++;
      else if (page.state === 'FREEING') stats.pages_freeing++;
      else if (page.state === 'CORRUPT') stats.pages_corrupted++;

      // Check page header CRC
      const pageCrcCalc = NVSEditor.crc32Header(this.data, page.offset);
      if (pageCrcCalc !== page.crc32) {
        stats.pages_bad_header_crc++;
      }

      for (const item of page.items) {
        const itemState = this._getNVSItemState(this.data.slice(page.offset + 32, page.offset + 64), 
                                                 (item.offset - page.offset - 64) / 32);
        
        if (itemState === 2) stats.entries_written++;
        else if (itemState === 0) stats.entries_erased++;
        else stats.entries_empty++;

        // Check entry header CRC
        if (!item.headerCrcValid) {
          stats.entries_bad_header_crc++;
        }

        // Check data CRC for string/blob types
        if (item.dataCrcValid !== undefined && !item.dataCrcValid) {
          stats.entries_bad_data_crc++;
        }
      }
    }

    return stats;
  }

  getNamespaces() {
    const namespaces = new Map();
    for (const page of this.pages) {
      for (const item of page.items) {
        if (item.nsIndex === 0 && item.namespace) {
          namespaces.set(item.value, item.namespace);
        }
      }
    }
    return namespaces;
  }

  // ─────── Blob integrity checking (from Berry nvs.be) ───────

  getBlobs() {
    const blobs = new Map();
    
    for (const page of this.pages) {
      for (const item of page.items) {
        if (NVSEditor.isBlob(item) && item.key) {
          const key = item.key;
          if (!blobs.has(key)) {
            blobs.set(key, {
              key: key,
              totalSize: NVSEditor.blobTotalSize(item),
              expectedChunks: NVSEditor.blobExpectedChunks(item),
              chunks: [],
              indexEntry: item
            });
          }
          
          const blob = blobs.get(key);
          
          // Update totals if this entry has better information
          const totalSize = NVSEditor.blobTotalSize(item);
          const expectedChunks = NVSEditor.blobExpectedChunks(item);
          if (totalSize > 0) blob.totalSize = totalSize;
          if (expectedChunks > 0) blob.expectedChunks = expectedChunks;
          
          // For blob_index entries
          if (item.datatype === 0x48) {
            blob.indexEntry = item;
          }
          
          // For blob_data entries, add chunk reference
          if (item.datatype === 0x42 && item.size > 0) {
            const payloadOffset = item.offset + 32;
            const payloadLength = (item.span - 1) * 32;
            const chunkIndex = item.chunkIndex & 127;
            if (payloadLength > 0) {
              blob.chunks.push({
                offset: payloadOffset,
                length: Math.min(payloadLength, item.size),
                index: chunkIndex
              });
            }
          }
          
          // For inline blob (small blobs stored in header)
          if (item.datatype === 0x42 && item.size > 0 && item.span === 1) {
            const inlineOff = item.offset + 24;
            blob.chunks.push({
              offset: inlineOff,
              length: item.size,
              index: 0
            });
          }
        }
      }
    }
    
    return blobs;
  }

  checkBlobIntegrity(blobs) {
    let complete = 0;
    let incomplete = 0;
    
    for (const [key, blob] of blobs) {
      const present = blob.chunks.length;
      const expected = blob.expectedChunks;
      
      if (expected > 0) {
        if (present >= expected) {
          complete++;
        } else {
          incomplete++;
        }
      } else {
        // Legacy/inline blob - no expected chunk count
        if (present > 0) {
          complete++;
        } else {
          incomplete++;
        }
      }
    }
    
    return { complete, incomplete };
  }

  getBlobData(blob) {
    // Sort chunks by index
    const sortedChunks = [...blob.chunks].sort((a, b) => a.index - b.index);
    
    // Assemble blob data
    const totalSize = sortedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    
    for (const chunk of sortedChunks) {
      const chunkData = this.data.slice(chunk.offset, chunk.offset + chunk.length);
      result.set(chunkData, offset);
      offset += chunk.length;
    }
    
    return result;
  }

  // ─────── Public API ───────

  /** Show a progress overlay (before open()) */
  initProgressUI() {
    this.container.innerHTML = `
      <div class="nvseditor-body" style="flex:1;display:flex;align-items:center;justify-content:center;">
        <div class="nvseditor-progress-overlay" id="nvsProgress">
          <div class="progress-text" id="nvsProgressText">Initiating...</div>
          <div class="progress-bar-outer">
            <div class="progress-bar-inner" id="nvsProgressBar"></div>
          </div>
        </div>
      </div>`;
    this._progressOverlay = this.container.querySelector('#nvsProgress');
    this._progressText = this.container.querySelector('#nvsProgressText');
    this._progressBarInner = this.container.querySelector('#nvsProgressBar');
  }

  showProgress(text, percent) {
    if (this._progressOverlay) {
      this._progressOverlay.classList.remove('hidden');
      this._progressText.textContent = text;
      this._progressBarInner.style.width = percent + '%';
    }
  }

  hideProgress() {
    if (this._progressOverlay) {
      this._progressOverlay.classList.add('hidden');
    }
  }

  /**
   * Open the NVS editor with data.
   * @param {Uint8Array} data         - raw NVS partition bytes
   * @param {number}     baseAddress  - flash offset of the partition
   * @param {string}     name         - partition name
   */
  open(data, baseAddress, name) {
    this.data = new Uint8Array(data);
    this.originalData = new Uint8Array(data);
    this.baseAddress = baseAddress;
    this.partitionSize = data.length;
    this.partitionName = name || 'nvs';
    this.modified = false;
    this._filterText = '';

    this.pages = this._parse();
    this._buildUI();

    this.container.classList.remove('hidden');
    document.body.classList.add('nvseditor-active');
  }

  close() {
    if (this._hexEditorInstance) {
      this._hexEditorInstance.onClose = null; // prevent re-render on already-closing editor
      try { this._hexEditorInstance.close(); } catch (_) {}
      this._hexEditorInstance = null;
    }
    this.container.classList.add('hidden');
    document.body.classList.remove('nvseditor-active');
    this.container.innerHTML = '';
    if (this.onClose) this.onClose();
  }

  // ─────── NVS parsing (synchronous, operates on Uint8Array) ───────

  _readString(offset, maxLen) {
    let r = '';
    for (let i = 0; i < maxLen; i++) {
      const b = this.data[offset + i];
      if (b === 0) break;
      if (b >= 32 && b <= 126) r += String.fromCharCode(b);
      else return r;
    }
    return r;
  }

  _u8(off) { return this.data[off]; }
  _u16(off) { return this.data[off] | (this.data[off + 1] << 8); }
  _u32(off) { return (this.data[off] | (this.data[off + 1] << 8) | (this.data[off + 2] << 16) | (this.data[off + 3] << 24)) >>> 0; }
  _i32(off) { return this._u32(off) | 0; }
  _u64(off) {
    const lo = this._u32(off);
    const hi = this._u32(off + 4);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  _i64(off) { return BigInt.asIntN(64, this._u64(off)); }

  _getNVSTypeName(dt) {
    const m = {
      0x01: 'U8', 0x02: 'U16', 0x04: 'U32', 0x08: 'U64',
      0x11: 'I8', 0x12: 'I16', 0x14: 'I32', 0x18: 'I64',
      0x21: 'String', 0x42: 'Blob', 0x48: 'Blob Index'
    };
    return m[dt] || `0x${dt.toString(16)}`;
  }

  _getNVSItemState(bitmap, index) {
    const bmpIdx = Math.floor(index / 4);
    const bmpBit = (index % 4) * 2;
    return (bitmap[bmpIdx] >> bmpBit) & 3;
  }

  _setNVSItemState(bitmap, index, state) {
    const bmpIdx = Math.floor(index / 4);
    const bmpBit = (index % 4) * 2;
    bitmap[bmpIdx] &= ~(3 << bmpBit);
    bitmap[bmpIdx] |= (state << bmpBit);
  }

  _parse() {
    const NVS_SECTOR_SIZE = 4096;
    const MAX_ENTRY_COUNT = 126;
    const NVS_PAGE_STATE = {
      UNINIT: 0xFFFFFFFF, ACTIVE: 0xFFFFFFFE,
      FULL: 0xFFFFFFFC, FREEING: 0xFFFFFFF8, CORRUPT: 0xFFFFFFF0
    };

    const pages = [];
    const namespaces = new Map();
    namespaces.set(0, '');

   // ── Pass 1: collect all namespace definitions ──────────────────────────
   for (let secOff = 0; secOff < this.data.length; secOff += NVS_SECTOR_SIZE) {
     if (secOff + 64 > this.data.length) break;
     const state = this._u32(secOff);
     if (state === NVS_PAGE_STATE.UNINIT || state === NVS_PAGE_STATE.CORRUPT) continue;
     const stateBitmap = this.data.slice(secOff + 32, secOff + 64);
     for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
       if (this._getNVSItemState(stateBitmap, entry) !== 2) continue;
       const eOff = secOff + 64 + entry * 32;
       if (eOff + 32 > this.data.length) break;
       const span = this._u8(eOff + 2);
       if (this._u8(eOff) === 0 && this._u8(eOff + 1) !== 0xFF && this._u8(eOff + 1) !== 0x00) {
         namespaces.set(this._u8(eOff + 24), this._readString(eOff + 8, 16));
       }
       if (span > 1) entry += span - 1;
     }
   }

    for (let secOff = 0; secOff < this.data.length; secOff += NVS_SECTOR_SIZE) {
      if (secOff + 64 > this.data.length) break;
      const state = this._u32(secOff);

      let stateName = 'UNKNOWN';
      if (state === NVS_PAGE_STATE.UNINIT) { stateName = 'UNINIT'; }
      else if (state === NVS_PAGE_STATE.ACTIVE) { stateName = 'ACTIVE'; }
      else if (state === NVS_PAGE_STATE.FULL) { stateName = 'FULL'; }
      else if (state === NVS_PAGE_STATE.FREEING) { stateName = 'FREEING'; }
      else if (state === NVS_PAGE_STATE.CORRUPT) { stateName = 'CORRUPT'; }

      if (stateName === 'UNINIT' || stateName === 'CORRUPT') continue;

      const seq = this._u32(secOff + 4);
      const version = this._u8(secOff + 8);
      const crc32 = this._u32(secOff + 28);
      const stateBitmap = this.data.slice(secOff + 32, secOff + 64);

      const page = { offset: secOff, state: stateName, seq, version, crc32, items: [] };

      for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
        const itemState = this._getNVSItemState(stateBitmap, entry);
        if (itemState !== 2) continue; // only WRITTEN entries

        const eOff = secOff + 64 + entry * 32;
        if (eOff + 32 > this.data.length) break;

        const nsIndex = this._u8(eOff);
        const datatype = this._u8(eOff + 1);
        const span = this._u8(eOff + 2);
        const chunkIndex = this._u8(eOff + 3);

        if (span === 0 || span > 126) continue;
        if (datatype === 0xFF || datatype === 0x00) continue;
        if (nsIndex === 0xFF) continue;

        const crc = this._u32(eOff + 4);
        const key = this._readString(eOff + 8, 16);

        if (nsIndex !== 0 && (!key || key.length === 0)) continue;

        const headerCrcCalc = NVSEditor.crc32Header(this.data, eOff);

        const item = {
          nsIndex, datatype, span, chunkIndex,
          crc32: crc >>> 0,
          headerCrcCalc: headerCrcCalc >>> 0,
          headerCrcValid: (crc >>> 0) === (headerCrcCalc >>> 0),
          key,
          value: null,
          typeName: this._getNVSTypeName(datatype),
          offset: eOff,
          entrySize: 32,
          pageOffset: secOff
        };

        // Namespace definition
        if (nsIndex === 0) {
          const namespaceIndex = this._u8(eOff + 24);
          item.value = namespaceIndex;
          item.namespace = key;
          namespaces.set(namespaceIndex, key);
        } else {
          switch (datatype) {
            case 0x01: item.value = this._u8(eOff + 24); break;
            case 0x02: item.value = this._u16(eOff + 24); break;
            case 0x04: item.value = this._u32(eOff + 24); break;
            case 0x08: item.value = this._u64(eOff + 24).toString(); break;
            case 0x11: item.value = (this._u8(eOff + 24) > 127 ? this._u8(eOff + 24) - 256 : this._u8(eOff + 24)); break;
            case 0x12: { const v = this._u16(eOff + 24); item.value = v > 32767 ? v - 65536 : v; break; }
            case 0x14: item.value = this._i32(eOff + 24); break;
            case 0x18: item.value = this._i64(eOff + 24).toString(); break;
            case 0x21: { // String
              const strSize = this._u16(eOff + 24);
              const strCrc = this._u32(eOff + 28);
              if (strSize > 0 && strSize < 4096 && eOff + 32 + strSize <= this.data.length) {
                const strData = this.data.slice(eOff + 32, eOff + 32 + strSize);
                const allErased = strData.every(b => b === 0xFF);
                // Find first NUL byte and decode as UTF-8
                let nullIndex = strData.length;
                for (let i = 0; i < strData.length; i++) {
                  if (strData[i] === 0) { nullIndex = i; break; }
                }
                const sv = nullIndex > 0 ? new TextDecoder('utf-8').decode(strData.subarray(0, nullIndex)) : '';
                item.value = allErased ? '<erased>' : sv;
                item.rawValue = strData;
                item.dataCrcStored = strCrc >>> 0;
                item.dataCrcCalc = NVSEditor.crc32(strData, 0, strSize) >>> 0;
                item.dataCrcValid = item.dataCrcCalc === item.dataCrcStored;
                item.size = strSize;
                item.entrySize = 32 + strSize;
              } else {
                item.value = '<invalid string>';
                item.size = 0;
              }
              break;
            }
            case 0x42: { // Blob
              const blobSize = this._u16(eOff + 24);
              const blobCrc = this._u32(eOff + 28);
              if (blobSize > 0 && blobSize < 4096 && eOff + 32 + blobSize <= this.data.length) {
                const blobData = this.data.slice(eOff + 32, eOff + 32 + blobSize);
                const allErased = blobData.every(b => b === 0xFF);
                item.value = allErased ? '<erased>' : NVSEditor.bytesToHex(blobData, ' ');
                item.rawValue = blobData;
                item.dataCrcStored = blobCrc >>> 0;
                item.dataCrcCalc = NVSEditor.crc32(blobData, 0, blobSize) >>> 0;
                item.dataCrcValid = item.dataCrcCalc === item.dataCrcStored;
                item.size = blobSize;
                item.entrySize = 32 + blobSize;
              } else {
                item.value = '<invalid blob>';
                item.size = 0;
              }
              break;
            }
            case 0x48: { // Blob Index
              item.totalSize = this._u32(eOff + 24);
              item.chunkCount = this._u8(eOff + 28);
              item.chunkStart = this._u8(eOff + 29);
              item.value = `${item.chunkCount} chunks, ${item.totalSize} bytes total`;
              break;
            }
          }
        }

        page.items.push(item);
        if (span > 1) entry += span - 1;
      }

      pages.push(page);
    }
   // Resolve all item namespaces after both passes
   for (const page of pages)
     for (const it of page.items)
       if (it.nsIndex && it.nsIndex !== 0)
         it.namespace = namespaces.get(it.nsIndex) || `ns_${it.nsIndex}`;

    return pages;
  }

  // ─────── NVS write helpers ───────

  /** Delete an NVS entry by zeroing it and updating the bitmap */
  _deleteEntry(item) {
    const pageOff = item.pageOffset;
    const entryIdx = (item.offset - pageOff - 64) / 32;

    const stateBitmap = this.data.slice(pageOff + 32, pageOff + 64);

    for (let s = 0; s < item.span; s++) {
      const off = item.offset + s * 32;
      this.data.fill(0xFF, off, off + 32);
      this._setNVSItemState(stateBitmap, entryIdx + s, 0); // ERASED = 0
    }
    // Write back bitmap
    this.data.set(stateBitmap, pageOff + 32);
    this.modified = true;
  }

  // ─────── UI ───────

  _buildUI() {
    const sizeStr = this.partitionSize >= 1024 * 1024
      ? (this.partitionSize / (1024 * 1024)).toFixed(1) + ' MB'
      : this.partitionSize >= 1024
        ? (this.partitionSize / 1024).toFixed(1) + ' KB'
        : this.partitionSize + ' B';

    const totalItems = this.pages.reduce((s, p) => s + p.items.length, 0);

    this.container.innerHTML = `
      <div class="nvseditor-toolbar">
        <h3>NVS Editor</h3>
        <span class="nvs-info">
          Partition: <b>${this._esc(this.partitionName)}</b> |
          Offset: 0x${this.baseAddress.toString(16).toUpperCase()} |
          Size: ${sizeStr} |
          ${this.pages.length} page(s), ${totalItems} entries
        </span>
        <span class="spacer"></span>
        <div class="nvseditor-filter">
          <input id="nvsFilter" type="text" placeholder="Filter by namespace or key..." />
        </div>
        <button id="nvsStats" title="Show statistics and integrity report">📊 Stats</button>
        <button id="nvsBlobs" title="Show blob information">📦 Blobs</button>
        <button id="nvsNamespaces" title="Show namespaces">📁 Namespaces</button>
        <button id="nvsRefresh" title="Re-parse data">Refresh</button>
        <button id="nvsWrite" class="primary" disabled>Write to Flash</button>
        <button id="nvsClose">Close</button>
      </div>
      <div class="nvseditor-body">
        <div class="nvseditor-progress-overlay hidden" id="nvsProgress">
          <div class="progress-text" id="nvsProgressText">Loading...</div>
          <div class="progress-bar-outer">
            <div class="progress-bar-inner" id="nvsProgressBar"></div>
          </div>
        </div>
        <div class="nvseditor-content" id="nvsContent"></div>
      </div>
      <div class="nvseditor-statusbar">
        <span id="nvsStatus">${totalItems} entries in ${this.pages.length} page(s)</span>
      </div>
      <div id="nvsHexEditorContainer" class="hexeditor-container hidden"></div>`;

    this._hexEditorContainer = this.container.querySelector('#nvsHexEditorContainer');

    this._progressOverlay = this.container.querySelector('#nvsProgress');
    this._progressText = this.container.querySelector('#nvsProgressText');
    this._progressBarInner = this.container.querySelector('#nvsProgressBar');

    // Close
    this.container.querySelector('#nvsClose').addEventListener('click', () => {
      if (this.modified) {
        if (!confirm('You have unsaved modifications. Close anyway?')) return;
      }
      this.close();
    });

    // Write
    const butWrite = this.container.querySelector('#nvsWrite');
    butWrite.addEventListener('click', async () => {
      if (!this.onWriteFlash) return;
      butWrite.disabled = true;
      try {
        this.showProgress('Writing NVS to flash...', 0);
        await this.onWriteFlash(this.data);
        this.originalData = new Uint8Array(this.data);
        this.modified = false;
        butWrite.disabled = true;
        this.showProgress('Write complete!', 100);
        setTimeout(() => this.hideProgress(), 1000);
      } catch (e) {
        alert('Write failed: ' + e);
        this.hideProgress();
      } finally {
        butWrite.disabled = this.modified === false;
      }
    });

    // Refresh
    this.container.querySelector('#nvsRefresh').addEventListener('click', () => {
      this.pages = this._parse();
      this._renderContent();
    });

    // Filter
    this.container.querySelector('#nvsFilter').addEventListener('input', (e) => {
      this._filterText = e.target.value.toLowerCase();
      this._renderContent();
    });

    // Stats button
    this.container.querySelector('#nvsStats').addEventListener('click', () => {
      this._showStats();
    });

    // Blobs button
    this.container.querySelector('#nvsBlobs').addEventListener('click', () => {
      this._showBlobs();
    });

    // Namespaces button
    this.container.querySelector('#nvsNamespaces').addEventListener('click', () => {
      this._showNamespaces();
    });

    this._renderContent();
  }

  _esc(s) {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  _renderContent() {
    const content = this.container.querySelector('#nvsContent');
    if (!content) return;

    const filter = this._filterText;

    let html = '';

    for (const page of this.pages) {
      // Group items by namespace
      const nsGroups = new Map();
      const nsDefs = [];

      for (const item of page.items) {
        if (item.nsIndex === 0) {
          nsDefs.push(item);
          continue;
        }
        const ns = item.namespace || `ns_${item.nsIndex}`;
        if (!nsGroups.has(ns)) nsGroups.set(ns, []);
        nsGroups.get(ns).push(item);
      }

      // Apply filter
      let hasVisibleItems = false;
      if (filter) {
        for (const [ns, items] of nsGroups) {
          const filtered = items.filter(it =>
            ns.toLowerCase().includes(filter) ||
            it.key.toLowerCase().includes(filter) ||
            String(it.value).toLowerCase().includes(filter)
          );
          if (filtered.length > 0) hasVisibleItems = true;
        }
        // Also check namespace defs
        for (const nd of nsDefs) {
          if (nd.key.toLowerCase().includes(filter)) hasVisibleItems = true;
        }
        if (!hasVisibleItems) continue;
      } else {
        hasVisibleItems = true;
      }

      const stateClass = page.state === 'ACTIVE' ? 'state-active' :
                          page.state === 'FULL' ? 'state-full' :
                          page.state === 'FREEING' ? 'state-freeing' : 'state-other';

      html += `<div class="nvs-page">
        <div class="nvs-page-header ${stateClass}">
          <span class="nvs-page-state">${page.state}</span>
          <span>Page @ 0x${page.offset.toString(16).toUpperCase()}</span>
          <span>Seq: ${page.seq}</span>
          <span>Version: ${page.version === 0xFF ? 'v1' : page.version === 0xFE ? 'v2' : page.version}</span>
          <span>${page.items.length} entries</span>
        </div>`;

      // Render namespace groups
      for (const [ns, items] of nsGroups) {
        const filteredItems = filter
          ? items.filter(it =>
              ns.toLowerCase().includes(filter) ||
              it.key.toLowerCase().includes(filter) ||
              String(it.value).toLowerCase().includes(filter))
          : items;
        if (filteredItems.length === 0) continue;

        html += `<div class="nvs-namespace">
          <div class="nvs-namespace-header">
            <span class="nvs-ns-icon">📁</span>
            <span class="nvs-ns-name">${this._esc(ns)}</span>
            <span class="nvs-ns-count">${filteredItems.length} item(s)</span>
          </div>
          <table class="nvs-table">
            <thead><tr>
              <th>Key</th><th>Type</th><th>Value</th><th>CRC</th><th>Offset</th><th>Actions</th>
            </tr></thead>
            <tbody>`;

        for (const item of filteredItems) {
          const crcOk = item.headerCrcValid !== false;
          const dataCrcOk = item.dataCrcValid !== undefined ? item.dataCrcValid : true;
          const crcClass = (crcOk && dataCrcOk) ? 'crc-ok' : 'crc-bad';
          const crcText = (crcOk && dataCrcOk) ? '✓' : '✗';

          let displayValue = String(item.value ?? '');
          if (displayValue.length > 120) displayValue = displayValue.substring(0, 120) + '…';

          const editable = true;

          html += `<tr>
            <td class="nvs-key" title="${this._esc(item.key)}">${this._esc(item.key)}</td>
            <td class="nvs-type">${this._esc(item.typeName)}</td>
            <td class="nvs-value" title="${this._esc(String(item.value ?? ''))}">${this._esc(displayValue)}</td>
            <td class="nvs-crc ${crcClass}">${crcText}</td>
            <td class="nvs-offset">0x${(this.baseAddress + item.offset).toString(16).toUpperCase()}</td>
            <td class="nvs-actions">
              ${editable ? `<button class="nvs-btn-edit" data-offset="${item.offset}" title="Edit value">✎</button>` : ''}
              <button class="nvs-btn-delete" data-offset="${item.offset}" title="Delete entry">✕</button>
            </td>
          </tr>`;
        }

        html += `</tbody></table></div>`;
      }

      html += `</div>`;
    }

    if (html === '') {
      html = '<div class="nvs-empty">No NVS entries found' + (filter ? ' matching filter' : '') + '</div>';
    }

    content.innerHTML = html;

    // Bind edit buttons
    content.querySelectorAll('.nvs-btn-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const off = parseInt(btn.dataset.offset, 10);
        this._editItem(off);
      });
    });

    // Bind delete buttons
    content.querySelectorAll('.nvs-btn-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const off = parseInt(btn.dataset.offset, 10);
        this._deleteItemUI(off);
      });
    });

    this._updateWriteButton();
  }

  _findItem(offset) {
    for (const page of this.pages) {
      for (const item of page.items) {
        if (item.offset === offset) return item;
      }
    }
    return null;
  }

  _editItem(offset) {
    const item = this._findItem(offset);
    if (!item) return;
    this._editItemInHexEditor(item);
  }

  /**
   * Open the HexEditor for any NVS entry.
   * Primitive types (U8..I64, Blob Index) → 8-byte data field at off+24.
   * String / Blob → multi-span payload at off+32.
   */
  _editItemInHexEditor(item) {
    const off = item.offset;
    const isPrimitive = !(item.datatype === 0x21 || item.datatype === 0x42);

    let dataOffset, dataSize, maxSize;
    if (isPrimitive) {
      // Primitive types store value in 8 bytes at header offset 24
      dataOffset = off + 24;
      dataSize = 8;
      maxSize = 8;
    } else {
      // String / Blob: payload after the 32-byte header
      dataOffset = off + 32;
      dataSize = item.size || (item.rawValue ? item.rawValue.length : 0);
      maxSize = (item.span - 1) * 32;
      if (dataSize <= 0) { alert('No data to edit'); return; }
    }

    const entryData = this.data.slice(dataOffset, dataOffset + dataSize);

    if (!this._hexEditorInstance) {
      this._hexEditorInstance = new HexEditor(this._hexEditorContainer);
    }

    this._hexEditorContainer.classList.remove('hidden');
    this._hexEditorInstance.open(entryData, 0);

    // Relabel button and show entry info
    const writeBtn = this._hexEditorContainer.querySelector('#hexedWrite');
    if (writeBtn) writeBtn.textContent = 'Apply Changes';

    this._hexEditorInstance.onWriteFlash = async (editedData, modifiedOffsets) => {
      if (modifiedOffsets.size === 0) return;

      if (editedData.length > maxSize) {
        alert('Edited data exceeds available slot size (' + maxSize + ' bytes)');
        return;
      }

      if (isPrimitive) {
        // Write the 8 data bytes back into the header
        this.data.set(editedData.slice(0, 8), dataOffset);
      } else {
        // Clear payload area, then write
        this.data.fill(0xFF, dataOffset, dataOffset + maxSize);
        this.data.set(editedData, dataOffset);
        // Update size field
        this.data[off + 24] = editedData.length & 0xFF;
        this.data[off + 25] = (editedData.length >> 8) & 0xFF;
        // Update data CRC
        const crc = NVSEditor.crc32(editedData);
        const dv = new DataView(this.data.buffer, off + 28, 4);
        dv.setUint32(0, crc, true);
      }

      // Recalculate header CRC
      const hcrc = NVSEditor.crc32Header(this.data, off);
      const hdv = new DataView(this.data.buffer, off + 4, 4);
      hdv.setUint32(0, hcrc, true);

      this.modified = true;

      this._hexEditorInstance.showProgress('Applied to NVS!', 100);
      await new Promise(r => setTimeout(r, 500));
      this._hexEditorInstance.hideProgress();
    };

    this._hexEditorInstance.onClose = () => {
      this._hexEditorContainer.classList.add('hidden');
      this._hexEditorInstance = null;
      this.pages = this._parse();
      this._renderContent();
    };
  }

  _deleteItemUI(offset) {
    const item = this._findItem(offset);
    if (!item) return;

    const ns = item.namespace || `ns_${item.nsIndex}`;
    if (!confirm(`Delete ${ns}.${item.key}?`)) return;

    this._deleteEntry(item);
    this.pages = this._parse();
    this._renderContent();
  }

  _updateWriteButton() {
    const btn = this.container.querySelector('#nvsWrite');
    if (btn) btn.disabled = !this.modified;
  }

  // ─────── UI dialogs for new features ───────

  _showStats() {
    const stats = this.getStatistics();
    const blobs = this.getBlobs();
    const blobIntegrity = this.checkBlobIntegrity(blobs);

    const ok = (stats.entries_bad_header_crc === 0) && 
               (stats.entries_bad_data_crc === 0) && 
               (stats.pages_bad_header_crc === 0) && 
               (stats.pages_corrupted === 0) && 
               (blobIntegrity.incomplete === 0);

    const html = `
      <div class="nvs-dialog-overlay" id="nvsStatsDialog">
        <div class="nvs-dialog">
          <div class="nvs-dialog-header">
            <h3>📊 NVS Statistics & Integrity Report</h3>
            <button class="nvs-dialog-close">×</button>
          </div>
          <div class="nvs-dialog-body">
            <h4>Pages</h4>
            <pre>Total: ${stats.pages_total} | Active: ${stats.pages_active} | Full: ${stats.pages_full} | Empty: ${stats.pages_empty} | Erasing: ${stats.pages_freeing} | Corrupted: ${stats.pages_corrupted}</pre>
            ${stats.pages_bad_header_crc > 0 ? `<pre class="nvs-warn">Pages with BAD header CRC: ${stats.pages_bad_header_crc}</pre>` : ''}
            
            <h4>Entries</h4>
            <pre>Written: ${stats.entries_written} | Erased: ${stats.entries_erased} | Empty: ${stats.entries_empty}</pre>
            ${stats.entries_bad_header_crc > 0 ? `<pre class="nvs-warn">Entries with BAD header CRC: ${stats.entries_bad_header_crc}</pre>` : ''}
            ${stats.entries_bad_data_crc > 0 ? `<pre class="nvs-warn">Entries with BAD data CRC: ${stats.entries_bad_data_crc}</pre>` : ''}
            
            <h4>Blobs</h4>
            <pre>Complete: ${blobIntegrity.complete} | Incomplete: ${blobIntegrity.incomplete}</pre>
            
            <h4>Overall Integrity</h4>
            <pre class="${ok ? 'nvs-ok' : 'nvs-error'}">${ok ? '✓ NVS integrity: OK' : '✗ NVS integrity: ISSUES DETECTED'}</pre>
          </div>
        </div>
      </div>`;

    const dialogContainer = document.createElement('div');
    dialogContainer.innerHTML = html;
    document.body.appendChild(dialogContainer);

    dialogContainer.querySelector('.nvs-dialog-close').addEventListener('click', () => {
      dialogContainer.remove();
    });

    dialogContainer.querySelector('.nvs-dialog-overlay').addEventListener('click', (e) => {
      if (e.target === dialogContainer.querySelector('.nvs-dialog-overlay')) {
        dialogContainer.remove();
      }
    });
  }

  _showBlobs() {
    const blobs = this.getBlobs();
    const blobIntegrity = this.checkBlobIntegrity(blobs);

    let html = '';
    if (blobs.size > 0) {
      for (const [key, blob] of blobs) {
        const present = blob.chunks.length;
        const expected = blob.expectedChunks;
        let status;
        if (expected > 0) {
          status = present >= expected ? 'OK' : `INCOMPLETE(${present}/${expected})`;
        } else {
          status = present > 0 ? 'OK' : 'EMPTY';
        }

        html += `
          <div class="nvs-blob-item">
            <div><strong>Key:</strong> ${this._esc(key)}</div>
            <div><strong>Total Size:</strong> ${blob.totalSize} bytes</div>
            <div><strong>Chunks:</strong> ${present}/${expected}</div>
            <div><strong>Status:</strong> <span class="${status === 'OK' ? 'nvs-ok' : 'nvs-warn'}">${status}</span></div>
            <button class="nvs-blob-dump" data-key="${this._esc(key)}" title="Show hex dump">📄 Hex Dump</button>
            <button class="nvs-blob-download" data-key="${this._esc(key)}" title="Download blob">⬇️ Download</button>
          </div>`;
      }
    } else {
      html = '<div class="nvs-empty">No blob entries found.</div>';
    }

    const dialogHtml = `
      <div class="nvs-dialog-overlay" id="nvsBlobsDialog">
        <div class="nvs-dialog">
          <div class="nvs-dialog-header">
            <h3>📦 Blobs Found (${blobs.size})</h3>
            <button class="nvs-dialog-close">×</button>
          </div>
          <div class="nvs-dialog-body">
            ${html}
          </div>
        </div>
      </div>`;

    const dialogContainer = document.createElement('div');
    dialogContainer.innerHTML = dialogHtml;
    document.body.appendChild(dialogContainer);

    dialogContainer.querySelector('.nvs-dialog-close').addEventListener('click', () => {
      dialogContainer.remove();
    });

    dialogContainer.querySelector('.nvs-dialog-overlay').addEventListener('click', (e) => {
      if (e.target === dialogContainer.querySelector('.nvs-dialog-overlay')) {
        dialogContainer.remove();
      }
    });

    // Blob dump buttons
    dialogContainer.querySelectorAll('.nvs-blob-dump').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const blob = blobs.get(key);
        const blobData = this.getBlobData(blob);
        const hexDump = NVSEditor.hexDump(blobData);
        alert(`Hex dump for ${key}:\n\n${hexDump}`);
      });
    });

    // Blob download buttons
    dialogContainer.querySelectorAll('.nvs-blob-download').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const blob = blobs.get(key);
        const blobData = this.getBlobData(blob);
        const fileBlob = new Blob([blobData], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(fileBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${key}.bin`;
        a.click();
        URL.revokeObjectURL(url);
      });
    });
  }

  _showNamespaces() {
    const namespaces = this.getNamespaces();

    let html = '';
    if (namespaces.size > 0) {
      for (const [index, name] of namespaces) {
        html += `<div class="nvs-namespace-item"><strong>Index ${index}:</strong> ${this._esc(name)}</div>`;
      }
    } else {
      html = '<div class="nvs-empty">No namespace entries found.</div>';
    }

    const dialogHtml = `
      <div class="nvs-dialog-overlay" id="nvsNamespacesDialog">
        <div class="nvs-dialog">
          <div class="nvs-dialog-header">
            <h3>📁 Namespaces Found (${namespaces.size})</h3>
            <button class="nvs-dialog-close">×</button>
          </div>
          <div class="nvs-dialog-body">
            ${html}
          </div>
        </div>
      </div>`;

    const dialogContainer = document.createElement('div');
    dialogContainer.innerHTML = dialogHtml;
    document.body.appendChild(dialogContainer);

    dialogContainer.querySelector('.nvs-dialog-close').addEventListener('click', () => {
      dialogContainer.remove();
    });

    dialogContainer.querySelector('.nvs-dialog-overlay').addEventListener('click', (e) => {
      if (e.target === dialogContainer.querySelector('.nvs-dialog-overlay')) {
        dialogContainer.remove();
      }
    });
  }
}
