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

// ─────── NVS partition layout constants ───────
const NVS_SECTOR_SIZE = 4096;
const MAX_ENTRY_COUNT = 126;
const NVS_PAGE_STATE = {
  UNINIT:  0xFFFFFFFF,
  ACTIVE:  0xFFFFFFFE,
  FULL:    0xFFFFFFFC,
  FREEING: 0xFFFFFFF8,
  CORRUPT: 0xFFFFFFF0
};
const NVS_PAGE_STATE_NAME = {
  [NVS_PAGE_STATE.UNINIT]:  'UNINIT',
  [NVS_PAGE_STATE.ACTIVE]:  'ACTIVE',
  [NVS_PAGE_STATE.FULL]:    'FULL',
  [NVS_PAGE_STATE.FREEING]: 'FREEING',
  [NVS_PAGE_STATE.CORRUPT]: 'CORRUPT'
};

function pageStateName(stateValue) {
  return NVS_PAGE_STATE_NAME[stateValue >>> 0] || 'UNKNOWN';
}

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

  /** Entry header CRC: covers bytes [+0..+3] and [+8..+31], stored at [+4..+7]. */
  static crc32Header(data, offset = 0) {
    const buf = new Uint8Array(0x20 - 4);
    buf.set(data.subarray(offset, offset + 4), 0);
    buf.set(data.subarray(offset + 8, offset + 8 + 0x18), 4);
    return NVSEditor.crc32(buf, 0, 0x1C);
  }

  /** Page header CRC: covers bytes [+4..+27] (seqNum..reserved), stored at [+28..+31].
   * State field [+0..+3] excluded — matches nvs_page.cpp Header::calculateCrc32(). */
  static crc32PageHeader(data, offset = 0) {
    return NVSEditor.crc32(data, offset + 4, 24);
  }

  static bytesToHex(bytes, separator = '') {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(separator);
  }

  // ─────── Blob helpers (from Berry nvs.be) ───────

  static isBlob(item) {
    return item.datatype === 0x42 || item.datatype === 0x48;
  }

  static isBlobData(item) {
    return item.datatype === 0x42;
  }

  static blobKey(item) {
    return item.key;
  }

  /** Namespace-qualified blob ID to avoid cross-namespace collisions. */
  static getQualifiedBlobId(item) {
    const ns = item.namespace || `ns_${item.nsIndex}`;
    return `${ns}::${item.key}`;
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
      pages_total: 0,
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

    // Build lookup from sector offset → parsed page for entry-level CRC checks.
    const parsedPagesByOffset = new Map();
    for (const p of this.pages) parsedPagesByOffset.set(p.offset, p);

    for (let secOff = 0; secOff < this.data.length; secOff += NVS_SECTOR_SIZE) {
      if (secOff + 64 > this.data.length) break;
      stats.pages_total++;
      const stateValue = this._u32(secOff);
      const stateName = pageStateName(stateValue);

      if (stateName === 'ACTIVE')                           stats.pages_active++;
      else if (stateName === 'FULL')                        stats.pages_full++;
      else if (stateName === 'UNINIT')                      stats.pages_empty++;
      else if (stateName === 'FREEING')                     stats.pages_freeing++;
      else if (stateName === 'CORRUPT' || stateName === 'UNKNOWN') stats.pages_corrupted++;

      // UNINIT sectors have no header CRC or entries.
      if (stateName === 'UNINIT') continue;

      // Page header CRC (covers bytes +4..+27, stored at +28).
      const pageCrcCalc = NVSEditor.crc32PageHeader(this.data, secOff);
      const pageCrcStored = this._u32(secOff + 28);
      if (pageCrcCalc !== pageCrcStored) stats.pages_bad_header_crc++;

      // Corrupt/unknown pages have no parseable bitmap or entries.
      if (stateName === 'CORRUPT' || stateName === 'UNKNOWN') continue;

      // Iterate ALL slots in the page bitmap to count erased/empty/written.
      // NVS bitmap encoding: 0b00=Erased, 0b10=Written, 0b11=Empty, 0b01=Invalid
      const stateBitmap = this.data.slice(secOff + 32, secOff + 64);
      for (let slotIndex = 0; slotIndex < MAX_ENTRY_COUNT; slotIndex++) {
        const slotState = this._getNVSItemState(stateBitmap, slotIndex);
        if (slotState === 0) stats.entries_erased++;
        else if (slotState === 2) stats.entries_written++;
        else if (slotState === 3) stats.entries_empty++;
      }

      // Check entry header / data CRC for parsed (WRITTEN) items.
      const parsedPage = parsedPagesByOffset.get(secOff);
      if (parsedPage) {
        for (const item of parsedPage.items) {
          if (!item.headerCrcValid) stats.entries_bad_header_crc++;
          if (item.dataCrcValid !== undefined && !item.dataCrcValid) stats.entries_bad_data_crc++;
        }
      }
    }

    const blobIntegrity = this.checkBlobIntegrity(this.getBlobs());
    stats.blobs_complete = blobIntegrity.complete;
    stats.blobs_incomplete = blobIntegrity.incomplete;

    return stats;
  }

  /**
   * Collect detailed integrity issues for diagnostics.
   * Mirrors the kind of info `nvs.be` prints at higher loglevels.
   * @returns {{
   *   corruptedPages: Array,
   *   pagesBadHeaderCrc: Array,
   *   entriesBadHeaderCrc: Array,
   *   entriesBadDataCrc: Array,
   *   incompleteBlobs: Array
   * }}
   */
  getIntegrityIssues() {
    const issues = {
      corruptedPages: [],
      pagesBadHeaderCrc: [],
      malformedEntries: [],   // WRITTEN slots that the parser drops or that overflow
      entriesBadHeaderCrc: [],
      entriesBadDataCrc: [],
      incompleteBlobs: []
    };

    // Helper: index parsed pages by sector offset for quick lookup.
    const parsedPagesByOffset = new Map();
    for (const p of this.pages) parsedPagesByOffset.set(p.offset, p);

    // ── Scan ALL sectors of the partition (independent of this.pages) ──
    for (let secOff = 0; secOff < this.data.length; secOff += NVS_SECTOR_SIZE) {
      if (secOff + 64 > this.data.length) break;
      const pageIndex = Math.floor(secOff / NVS_SECTOR_SIZE);
      const stateValue = this._u32(secOff);
      const stateName = pageStateName(stateValue);

      // Corrupted or unknown state pages
      if (stateName === 'CORRUPT' || stateName === 'UNKNOWN') {
        issues.corruptedPages.push({
          pageIndex,
          offset: secOff,
          state: stateName,
          stateValue: stateValue >>> 0
        });
        continue; // don't iterate entries on a corrupt/unknown page
      }

      // UNINIT pages have no meaningful CRC/entries
      if (stateName === 'UNINIT') continue;

      // Check page header CRC
      const pageCrcCalc = NVSEditor.crc32PageHeader(this.data, secOff);
      const pageCrcStored = this._u32(secOff + 28);
      if (pageCrcCalc !== pageCrcStored) {
        issues.pagesBadHeaderCrc.push({
          pageIndex,
          offset: secOff,
          stored: pageCrcStored,
          calculated: pageCrcCalc
        });
      }

      // Walk every slot in the bitmap — find malformed WRITTEN entries
      // (these are silently dropped by _parse and would otherwise be invisible).
      const stateBitmap = this.data.slice(secOff + 32, secOff + 64);
      const parsedPage = parsedPagesByOffset.get(secOff);
      const parsedItemsBySlot = new Map();
      if (parsedPage) {
        for (const item of parsedPage.items) {
          const slot = (item.offset - secOff - 64) / 32;
          parsedItemsBySlot.set(slot, item);
        }
      }

      for (let slot = 0; slot < MAX_ENTRY_COUNT; slot++) {
        const slotState = this._getNVSItemState(stateBitmap, slot);

        // Invalid bitmap state value (0b01)
        if (slotState === 1) {
          issues.malformedEntries.push({
            pageIndex,
            pageOffset: secOff,
            slot,
            entryOffset: secOff + 64 + slot * 32,
            reason: 'Invalid bitmap state (0b01)',
            key: '<unknown>',
            namespace: '<unknown>',
            type: '<unknown>'
          });
          continue;
        }
        if (slotState !== 2) continue; // only WRITTEN slots can be malformed entries

        const eOff = secOff + 64 + slot * 32;
        if (eOff + 32 > this.data.length) {
          issues.malformedEntries.push({
            pageIndex, pageOffset: secOff, slot, entryOffset: eOff,
            reason: 'Entry header truncated by partition end',
            key: '<unknown>', namespace: '<unknown>', type: '<unknown>'
          });
          continue;
        }

        const nsIndex   = this._u8(eOff);
        const datatype  = this._u8(eOff + 1);
        const span      = this._u8(eOff + 2);
        const typeName  = this._getNVSTypeName(datatype);

        const reasons = [];
        if (span === 0 || span > 126)                reasons.push(`Invalid span (${span})`);
        if (datatype === 0xFF || datatype === 0x00)  reasons.push(`Invalid datatype (0x${datatype.toString(16)})`);
        if (nsIndex === 0xFF)                        reasons.push('Invalid namespace index (0xFF)');
        const key = this._readString(eOff + 8, 16);
        if (nsIndex !== 0 && (!key || key.length === 0)) reasons.push('Missing/empty key');
        if (span > 0 && span <= 126) {
          const lastEntryEnd = eOff + span * 32;
          if (lastEntryEnd > secOff + NVS_SECTOR_SIZE) {
            reasons.push(`Span overflows page (${span} entries from slot ${slot})`);
          }
        }

        const parsed = parsedItemsBySlot.get(slot);
        if (parsed) {
          // String/blob whose declared size doesn't fit the partition data
          if (parsed.value === '<invalid string>' || parsed.value === '<invalid blob>') {
            reasons.push(`Variable-length payload truncated/invalid (${typeName})`);
          }
        }

        if (reasons.length) {
          issues.malformedEntries.push({
            pageIndex,
            pageOffset: secOff,
            slot,
            entryOffset: eOff,
            reason: reasons.join('; '),
            key: key || '<unknown>',
            namespace: nsIndex === 0 ? '<ns def>' : `ns_${nsIndex}`,
            type: typeName
          });
        }

        if (span > 1) slot += span - 1;
      }

      // Per-item CRC checks for entries the parser DID accept
      if (parsedPage) {
        for (const item of parsedPage.items) {
          const slot = (item.offset - secOff - 64) / 32;
          const baseInfo = {
            pageIndex,
            pageOffset: secOff,
            slot,
            entryOffset: item.offset,
            key: item.key || '<no key>',
            namespace: item.namespace || `ns_${item.nsIndex}`,
            type: item.typeName
          };

          if (!item.headerCrcValid) {
            issues.entriesBadHeaderCrc.push({
              ...baseInfo,
              stored: item.crc32 >>> 0,
              calculated: item.headerCrcCalc >>> 0
            });
          }
          if (item.dataCrcValid === false) {
            issues.entriesBadDataCrc.push({
              ...baseInfo,
              size: item.size,
              stored: item.dataCrcStored >>> 0,
              calculated: item.dataCrcCalc >>> 0
            });
          }
        }
      }
    }

    // Blob completeness diagnostics
    const blobs = this.getBlobs();
    for (const [id, blob] of blobs) {
      const presentSet = new Set(blob.chunks.map(c => c.index));
      const present = presentSet.size;
      const expected = blob.expectedChunks;
      const presentIndices = Array.from(presentSet).sort((a, b) => a - b);

      let isIncomplete = false;
      let missing = [];
      if (expected > 0) {
        if (present < expected) {
          isIncomplete = true;
          // Determine starting chunk index from blob_index (chunkStart) when available
          const start = (blob.indexEntry && typeof blob.indexEntry.chunkStart === 'number')
            ? blob.indexEntry.chunkStart : 0;
          for (let i = 0; i < expected; i++) {
            const idx = start + i;
            if (!presentSet.has(idx)) missing.push(idx);
          }
        }
      } else if (present === 0) {
        isIncomplete = true;
      }

      if (isIncomplete) {
        issues.incompleteBlobs.push({
          key: `${blob.namespace}::${blob.key}`,
          present,
          expected,
          presentIndices,
          missingIndices: missing,
          totalSize: blob.totalSize,
          indexEntryOffset: blob.indexEntry ? blob.indexEntry.offset : null
        });
      }
    }

    return issues;
  }

  // ─────── Blob integrity checking (from Berry nvs.be) ───────

  getBlobs() {
    // First pass: collect blob_index and blob_data entries separately per qualified id.
    const indexEntriesById = new Map();  // qualifiedId → blob_index items[]
    const dataEntriesById  = new Map();  // qualifiedId → blob_data items[]

    for (const page of this.pages) {
      for (const item of page.items) {
        if (!NVSEditor.isBlob(item) || !item.key) continue;
        const id = NVSEditor.getQualifiedBlobId(item);
        if (item.datatype === 0x48) {
          if (!indexEntriesById.has(id)) indexEntriesById.set(id, []);
          indexEntriesById.get(id).push(item);
        } else if (item.datatype === 0x42) {
          if (!dataEntriesById.has(id)) dataEntriesById.set(id, []);
          dataEntriesById.get(id).push(item);
        }
      }
    }

    // Build a chunk array for data items, filtering by the index entry's expected range
    // [chunkStart, chunkStart + expectedChunks) when expectedChunks > 0.
    const buildChunks = (items, expectedChunks, chunkStart) => {
      const chunks = [];
      for (const item of items) {
        if (item.size <= 0) continue;
        const chunkIndex = item.chunkIndex;  // raw; must match blob_index chunkStart space
        if (expectedChunks > 0) {
          const rel = chunkIndex - chunkStart;
          if (rel < 0 || rel >= expectedChunks) continue;
        }
        if (item.span > 1) {
          const payloadLength = (item.span - 1) * 32;
          chunks.push({ offset: item.offset + 32, length: Math.min(payloadLength, item.size), index: chunkIndex });
        } else {
          // span === 1: inline data stored immediately after the 32-byte header.
          chunks.push({ offset: item.offset + 32, length: item.size, index: chunkIndex });
        }
      }
      return chunks;
    };

    const blobs = new Map();

    // Blobs with a blob_index entry: pick the best index entry, attach only its chunks.
    for (const [id, indices] of indexEntriesById) {
      // Prefer the first index entry that carries non-zero metadata.
      let best = indices[0];
      for (const idx of indices) {
        if (NVSEditor.blobTotalSize(idx) > 0 || NVSEditor.blobExpectedChunks(idx) > 0) {
          best = idx;
          break;
        }
      }
      const expectedChunks = NVSEditor.blobExpectedChunks(best);
      const chunkStart = typeof best.chunkStart === 'number' ? best.chunkStart : 0;
      blobs.set(id, {
        id,
        key: best.key,
        namespace: best.namespace || `ns_${best.nsIndex}`,
        totalSize: NVSEditor.blobTotalSize(best),
        expectedChunks,
        chunks: buildChunks(dataEntriesById.get(id) || [], expectedChunks, chunkStart),
        indexEntry: best
      });
    }

    // Legacy blobs: blob_data entries with no corresponding blob_index entry.
    for (const [id, items] of dataEntriesById) {
      if (blobs.has(id)) continue;
      const first = items[0];
      blobs.set(id, {
        id,
        key: first.key,
        namespace: first.namespace || `ns_${first.nsIndex}`,
        totalSize: NVSEditor.blobTotalSize(first),
        expectedChunks: 0,
        chunks: buildChunks(items, 0, 0),
        indexEntry: first
      });
    }

    return blobs;
  }

  checkBlobIntegrity(blobs) {
    let complete = 0;
    let incomplete = 0;
    
    for (const [key, blob] of blobs) {
      const present = new Set(blob.chunks.map(c => c.index)).size;
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

  /** HTML for a progress overlay; reused in initProgressUI() and _buildUI(). */
  static _progressOverlayHtml(extraClass = '', initialText = 'Loading...') {
    return `
      <div class="nvseditor-progress-overlay${extraClass ? ' ' + extraClass : ''}" id="nvsProgress">
        <div class="progress-text" id="nvsProgressText">${initialText}</div>
        <div class="progress-bar-outer">
          <div class="progress-bar-inner" id="nvsProgressBar"></div>
        </div>
      </div>`;
  }

  /** Cache references to the progress overlay DOM elements. */
  _cacheProgressEls() {
    this._progressOverlay = this.container.querySelector('#nvsProgress');
    this._progressText = this.container.querySelector('#nvsProgressText');
    this._progressBarInner = this.container.querySelector('#nvsProgressBar');
  }

  /** Show a progress overlay (before open()) */
  initProgressUI() {
    this.container.innerHTML = `
      <div class="nvseditor-body" style="flex:1;display:flex;align-items:center;justify-content:center;">
        ${NVSEditor._progressOverlayHtml('', 'Initiating...')}
      </div>`;
    this._cacheProgressEls();
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
      const stateName = pageStateName(state);

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
        <button id="nvsRefresh" title="Re-parse data">Refresh</button>
        <button id="nvsWrite" class="primary" disabled>Write to Flash</button>
        <button id="nvsClose">Close</button>
      </div>
      <div class="nvseditor-body">
        ${NVSEditor._progressOverlayHtml('hidden', 'Loading...')}
        <div class="nvseditor-content" id="nvsContent"></div>
      </div>
      <div class="nvseditor-statusbar">
        <span id="nvsStatus">${totalItems} entries in ${this.pages.length} page(s)</span>
      </div>
      <div id="nvsHexEditorContainer" class="hexeditor-container hidden"></div>`;

    this._hexEditorContainer = this.container.querySelector('#nvsHexEditorContainer');

    this._cacheProgressEls();

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

    this._renderContent();
  }

  _esc(s) {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  _matchesFilter(ns, item, filter) {
    if (!filter) return true;
    return ns.toLowerCase().includes(filter) ||
           item.key.toLowerCase().includes(filter) ||
           String(item.value).toLowerCase().includes(filter);
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
          if (items.some(it => this._matchesFilter(ns, it, filter))) {
            hasVisibleItems = true;
            break;
          }
        }
        // Also check namespace defs
        if (!hasVisibleItems) {
          for (const nd of nsDefs) {
            if (nd.key.toLowerCase().includes(filter)) { hasVisibleItems = true; break; }
          }
        }
        if (!hasVisibleItems) continue;
      } else {
        hasVisibleItems = true;
      }

      const stateClass = page.state === 'ACTIVE' ? 'state-active' :
                          page.state === 'FULL' ? 'state-full' :
                          page.state === 'FREEING' ? 'state-freeing' : 'state-other';

      html += `<div class="nvs-page" data-page-offset="${page.offset}">
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
          ? items.filter(it => this._matchesFilter(ns, it, filter))
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

          html += `<tr data-offset="${item.offset}">
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

  /** Scroll an entry row into view and highlight it briefly. */
  _scrollToEntry(offset) {
    const content = this.container.querySelector('#nvsContent');
    if (!content) return false;
    const row = content.querySelector(`tr[data-offset="${offset}"]`);
    if (!row) return false;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('nvs-row-highlight');
    setTimeout(() => row.classList.remove('nvs-row-highlight'), 2200);
    return true;
  }

  /** Scroll a page section into view and highlight it briefly. */
  _scrollToPage(pageOffset) {
    const content = this.container.querySelector('#nvsContent');
    if (!content) return false;
    const pageEl = content.querySelector(`.nvs-page[data-page-offset="${pageOffset}"]`);
    if (!pageEl) return false;
    pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pageEl.classList.add('nvs-page-highlight');
    setTimeout(() => pageEl.classList.remove('nvs-page-highlight'), 2200);
    return true;
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

  /** Create a modal dialog from `html`, append to <body>, wire up close handlers. */
  _createDialog(html) {
    const dialogContainer = document.createElement('div');
    dialogContainer.innerHTML = html;
    document.body.appendChild(dialogContainer);

    const overlay = dialogContainer.querySelector('.nvs-dialog-overlay');
    dialogContainer.querySelector('.nvs-dialog-close').addEventListener('click', () => {
      dialogContainer.remove();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) dialogContainer.remove();
    });
    return dialogContainer;
  }

  _showStats() {
    const stats = this.getStatistics();
    const blobs = this.getBlobs();
    const blobIntegrity = this.checkBlobIntegrity(blobs);
    const issues = this.getIntegrityIssues();

    const ok = (stats.entries_bad_header_crc === 0) &&
               (stats.entries_bad_data_crc === 0) &&
               (stats.pages_bad_header_crc === 0) &&
               (stats.pages_corrupted === 0) &&
               (blobIntegrity.incomplete === 0) &&
               (issues.corruptedPages.length === 0) &&
               (issues.malformedEntries.length === 0);

    const hex = (n) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const esc = (s) => this._esc(String(s));

    const pageActions = (pageOffset) => `
      <span class="nvs-issue-actions">
        <button class="nvs-issue-btn nvs-issue-goto-page" data-page-offset="${pageOffset}" title="Jump to page in editor">↪ Go to page</button>
      </span>`;
    const entryActions = (entryOffset) => `
      <span class="nvs-issue-actions">
        <button class="nvs-issue-btn nvs-issue-goto-entry" data-offset="${entryOffset}" title="Jump to entry in editor">↪ Go to</button>
        <button class="nvs-issue-btn nvs-issue-edit" data-offset="${entryOffset}" title="Edit entry">✎ Edit</button>
        <button class="nvs-issue-btn nvs-issue-delete" data-offset="${entryOffset}" title="Delete entry">✕ Delete</button>
      </span>`;

    let detailsHtml = '';
    if (!ok) {
      detailsHtml += '<h4>🔍 Issue Details</h4>';

      if (issues.corruptedPages.length) {
        detailsHtml += '<div class="nvs-issue-group"><div class="nvs-issue-title nvs-error">Corrupted / unknown-state pages</div>';
        for (const p of issues.corruptedPages) {
          detailsHtml += `<div class="nvs-issue-row"><pre class="nvs-issue">Page #${p.pageIndex}  offset=${hex(p.offset)}  state=${esc(p.state)}  stateValue=${hex(p.stateValue)}</pre>${pageActions(p.offset)}</div>`;
        }
        detailsHtml += '</div>';
      }

      if (issues.malformedEntries.length) {
        detailsHtml += '<div class="nvs-issue-group"><div class="nvs-issue-title nvs-warn">Malformed WRITTEN entries (parser-rejected)</div>';
        for (const e of issues.malformedEntries) {
          detailsHtml += `<div class="nvs-issue-row"><pre class="nvs-issue">Page #${e.pageIndex} slot ${e.slot}  ${esc(e.namespace)}::${esc(e.key)}  type=${esc(e.type)}  offset=${hex(e.entryOffset)}  reason: ${esc(e.reason)}</pre>${pageActions(e.pageOffset)}</div>`;
        }
        detailsHtml += '</div>';
      }

      if (issues.pagesBadHeaderCrc.length) {
        detailsHtml += '<div class="nvs-issue-group"><div class="nvs-issue-title nvs-warn">Pages with BAD header CRC</div>';
        for (const p of issues.pagesBadHeaderCrc) {
          detailsHtml += `<div class="nvs-issue-row"><pre class="nvs-issue">Page #${p.pageIndex}  offset=${hex(p.offset)}  stored=${hex(p.stored)}  calculated=${hex(p.calculated)}</pre>${pageActions(p.offset)}</div>`;
        }
        detailsHtml += '</div>';
      }

      if (issues.entriesBadHeaderCrc.length) {
        detailsHtml += '<div class="nvs-issue-group"><div class="nvs-issue-title nvs-warn">Entries with BAD header CRC</div>';
        for (const e of issues.entriesBadHeaderCrc) {
          detailsHtml += `<div class="nvs-issue-row"><pre class="nvs-issue">Page #${e.pageIndex} slot ${e.slot}  ${esc(e.namespace)}::${esc(e.key)}  type=${esc(e.type)}  offset=${hex(e.entryOffset)}  stored=${hex(e.stored)}  calculated=${hex(e.calculated)}</pre>${entryActions(e.entryOffset)}</div>`;
        }
        detailsHtml += '</div>';
      }

      if (issues.entriesBadDataCrc.length) {
        detailsHtml += '<div class="nvs-issue-group"><div class="nvs-issue-title nvs-warn">Entries with BAD data CRC</div>';
        for (const e of issues.entriesBadDataCrc) {
          detailsHtml += `<div class="nvs-issue-row"><pre class="nvs-issue">Page #${e.pageIndex} slot ${e.slot}  ${esc(e.namespace)}::${esc(e.key)}  type=${esc(e.type)}  size=${e.size}  offset=${hex(e.entryOffset)}  stored=${hex(e.stored)}  calculated=${hex(e.calculated)}</pre>${entryActions(e.entryOffset)}</div>`;
        }
        detailsHtml += '</div>';
      }

      if (issues.incompleteBlobs.length) {
        detailsHtml += '<div class="nvs-issue-group"><div class="nvs-issue-title nvs-warn">Incomplete blobs</div>';
        for (const b of issues.incompleteBlobs) {
          const missing = b.missingIndices.length
            ? ` missing chunks: [${b.missingIndices.join(', ')}]`
            : '';
          const present = b.presentIndices.length
            ? ` present chunks: [${b.presentIndices.join(', ')}]`
            : ' no chunks present';
          const actions = b.indexEntryOffset != null ? entryActions(b.indexEntryOffset) : '';
          detailsHtml += `<div class="nvs-issue-row"><pre class="nvs-issue">${esc(b.key)}  ${b.present}/${b.expected || '?'} chunks  totalSize=${b.totalSize}${present}${missing}</pre>${actions}</div>`;
        }
        detailsHtml += '</div>';
      }
    }

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

            ${detailsHtml}
          </div>
        </div>
      </div>`;

    const dialogContainer = this._createDialog(html);

    // Issue action buttons: jump / edit / delete
    dialogContainer.querySelectorAll('.nvs-issue-goto-page').forEach(btn => {
      btn.addEventListener('click', () => {
        const off = parseInt(btn.dataset.pageOffset, 10);
        dialogContainer.remove();
        this._scrollToPage(off);
      });
    });
    dialogContainer.querySelectorAll('.nvs-issue-goto-entry').forEach(btn => {
      btn.addEventListener('click', () => {
        const off = parseInt(btn.dataset.offset, 10);
        dialogContainer.remove();
        this._scrollToEntry(off);
      });
    });
    dialogContainer.querySelectorAll('.nvs-issue-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const off = parseInt(btn.dataset.offset, 10);
        dialogContainer.remove();
        this._scrollToEntry(off);
        this._editItem(off);
      });
    });
    dialogContainer.querySelectorAll('.nvs-issue-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const off = parseInt(btn.dataset.offset, 10);
        dialogContainer.remove();
        this._scrollToEntry(off);
        this._deleteItemUI(off);
      });
    });
  }

  _showBlobs() {
    const blobs = this.getBlobs();
    const blobIntegrity = this.checkBlobIntegrity(blobs);

    let html = '';
    if (blobs.size > 0) {
      for (const [id, blob] of blobs) {
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
            <div><strong>Namespace:</strong> ${this._esc(blob.namespace)}</div>
            <div><strong>Key:</strong> ${this._esc(blob.key)}</div>
            <div><strong>Total Size:</strong> ${blob.totalSize} bytes</div>
            <div><strong>Chunks:</strong> ${present}/${expected}</div>
            <div><strong>Status:</strong> <span class="${status === 'OK' ? 'nvs-ok' : 'nvs-warn'}">${status}</span></div>
            <button class="nvs-blob-dump" data-key="${this._esc(id)}" title="Show hex dump">📄 Hex Dump</button>
            <button class="nvs-blob-download" data-key="${this._esc(id)}" title="Download blob">⬇️ Download</button>
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

    const dialogContainer = this._createDialog(dialogHtml);

    // Blob dump buttons
    dialogContainer.querySelectorAll('.nvs-blob-dump').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.key;
        const blob = blobs.get(id);
        if (!blob) return;
        const blobData = this.getBlobData(blob);
        const hexDump = NVSEditor.hexDump(blobData);

        const dialogBody = dialogContainer.querySelector('.nvs-dialog-body');
        if (!dialogBody) return;

        // Reuse a single hex-dump pane per qualified blob id inside this dialog.
        // Append a djb2 hash of the original id to avoid collisions when two
        // different ids sanitize to the same string.
        let _h = 5381;
        for (let _i = 0; _i < id.length; _i++) _h = ((_h << 5) + _h) ^ id.charCodeAt(_i);
        const idHash = (_h >>> 0).toString(16).padStart(8, '0');
        const paneId = `nvs-hex-dump-${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${idHash}`;
        let pre = dialogBody.querySelector(`#${CSS.escape(paneId)}`);
        if (!pre) {
          pre = document.createElement('pre');
          pre.id = paneId;
          pre.className = 'nvs-hex-dump';
          pre.style.fontFamily = '"SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
          pre.style.fontSize = '12px';
          pre.style.background = '#f5f5f5';
          pre.style.border = '1px solid #e0e0e0';
          pre.style.borderRadius = '6px';
          pre.style.padding = '10px';
          pre.style.maxHeight = '400px';
          pre.style.overflow = 'auto';
          pre.style.whiteSpace = 'pre';
          pre.style.margin = '8px 0 18px 0';
          dialogBody.appendChild(pre);
        }
        // textContent escapes HTML by default
        pre.textContent = `Hex dump for ${id}:\n\n${hexDump}`;
        pre.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

    // Blob download buttons
    dialogContainer.querySelectorAll('.nvs-blob-download').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.key;
        const blob = blobs.get(id);
        if (!blob) return;
        const blobData = this.getBlobData(blob);
        const fileBlob = new Blob([blobData], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(fileBlob);
        const a = document.createElement('a');
        a.href = url;
        // Filename uses namespace + key to avoid collisions when downloading multiple blobs
        const safeName = `${blob.namespace}_${blob.key}`.replace(/[^A-Za-z0-9._-]/g, '_');
        a.download = `${safeName}.bin`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        // Defer cleanup so the download has time to start before the URL is revoked
        setTimeout(() => {
          URL.revokeObjectURL(url);
          a.remove();
        }, 0);
      });
    });
  }

}
