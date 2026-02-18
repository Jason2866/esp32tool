/**
 * ESP32Tool Flash Hex Editor
 * 
 * A full-screen hex editor for viewing and editing flash memory content.
 * Features:
 *   - Dual-pane display: HEX (left) + ASCII (right)
 *   - Inline editing in both HEX and ASCII panes
 *   - Search by HEX bytes or ASCII string
 *   - Go-to-address navigation
 *   - Virtual scrolling for large datasets (up to 16 MB)
 *   - Modified bytes highlighted, write-back only on explicit button press
 */

export class HexEditor {
  /**
   * @param {HTMLElement} container - The container element (#hexeditor-container)
   */
  constructor(container) {
    this.container = container;
    /** @type {Uint8Array|null} */
    this.data = null;
    /** @type {Uint8Array|null} Original snapshot for diff */
    this.originalData = null;
    this.baseAddress = 0;
    this.bytesPerRow = 16;
    this.rowHeight = 20;
    this.selectedOffset = -1;
    this.editingPane = null; // 'hex' or 'ascii'
    this.editBuffer = '';    // partial hex nibble during hex editing

    // Search state
    this.searchMatches = [];   // array of byte offsets
    this.currentMatchIdx = -1;

    // Callbacks
    this.onClose = null;
    /** @type {((data: Uint8Array, modified: Set<number>) => Promise<void>)|null} */
    this.onWriteFlash = null;

    /** @type {Set<number>} byte offsets that were modified */
    this.modifiedOffsets = new Set();

    // DOM references (set in _buildUI)
    this._viewport = null;
    this._rows = [];
    this._scrollContent = null;
    this._statusOffset = null;
    this._statusValue = null;
    this._statusModified = null;
    this._searchInput = null;
    this._searchMode = null;
    this._searchInfo = null;
    this._gotoInput = null;
    this._progressOverlay = null;
    this._progressText = null;
    this._progressBarInner = null;
    this._butWrite = null;

    // Virtual scroll
    this._visibleStart = 0;
    this._visibleCount = 0;
    this._totalRows = 0;

    this._boundHandleKeyDown = this._handleKeyDown.bind(this);
  }

  // ──────────────────── Public API ────────────────────

  /**
   * Open the hex editor with data.
   * @param {Uint8Array} data
   * @param {number} baseAddress - flash start address
   */
  open(data, baseAddress = 0) {
    this.data = new Uint8Array(data);
    this.originalData = new Uint8Array(data);
    this.baseAddress = baseAddress;
    this.modifiedOffsets.clear();
    this.searchMatches = [];
    this.currentMatchIdx = -1;
    this.selectedOffset = 0;
    this.editingPane = null;
    this.editBuffer = '';

    this._buildUI();
    this.container.classList.remove('hidden');
    document.body.classList.add('hexeditor-active');
    document.addEventListener('keydown', this._boundHandleKeyDown);

    this._calculateLayout();
    this._render();
    this._updateStatus();
    this._scrollToOffset(0);
  }

  /** Close hex editor */
  close() {
    this.container.classList.add('hidden');
    document.body.classList.remove('hexeditor-active');
    document.removeEventListener('keydown', this._boundHandleKeyDown);
    this.container.innerHTML = '';
    if (this.onClose) this.onClose();
  }

  /** Show loading overlay */
  showProgress(text, percent) {
    if (this._progressOverlay) {
      this._progressOverlay.classList.remove('hidden');
      this._progressText.textContent = text;
      this._progressBarInner.style.width = percent + '%';
    }
  }

  /** Hide loading overlay */
  hideProgress() {
    if (this._progressOverlay) {
      this._progressOverlay.classList.add('hidden');
    }
  }

  /** Check if there are unsaved modifications */
  hasModifications() {
    return this.modifiedOffsets.size > 0;
  }

  // ──────────────────── UI Build ────────────────────

  /**
   * Build a minimal progress-only UI for showing during flash read.
   * Called before open() so user sees loading feedback immediately.
   */
  _buildProgressUI() {
    this.container.innerHTML = `
      <div class="hexeditor-body" style="flex:1;">
        <div class="hexeditor-progress-overlay" id="hexedProgress">
          <div class="progress-text" id="hexedProgressText">Initiating flash read...</div>
          <div class="progress-bar-outer">
            <div class="progress-bar-inner" id="hexedProgressBar"></div>
          </div>
        </div>
      </div>
    `;
    this._progressOverlay = this.container.querySelector('#hexedProgress');
    this._progressText = this.container.querySelector('#hexedProgressText');
    this._progressBarInner = this.container.querySelector('#hexedProgressBar');
  }

  _buildUI() {
    const totalSize = this.data ? this.data.length : 0;
    const sizeStr = totalSize >= 1024 * 1024
      ? (totalSize / (1024 * 1024)).toFixed(1) + ' MB'
      : totalSize >= 1024
        ? (totalSize / 1024).toFixed(1) + ' KB'
        : totalSize + ' B';

    this.container.innerHTML = `
      <div class="hexeditor-toolbar">
        <h3>Flash Hex Editor</h3>
        <span style="font-size:11px;color:#888;margin-left:8px;">
          Base: 0x${this.baseAddress.toString(16).toUpperCase()} | Size: ${sizeStr}
        </span>
        <span class="spacer"></span>
        <div class="hexeditor-goto">
          <label style="font-size:12px;color:#aaa;">Go to: 0x</label>
          <input id="hexedGoto" type="text" placeholder="address" />
          <button id="hexedGotoBtn">Go</button>
        </div>
        <button id="hexedUndoAll" class="danger">Undo All</button>
        <button id="hexedWrite" class="primary" disabled>Write to Flash</button>
        <button id="hexedClose">Close</button>
      </div>
      <div class="hexeditor-search">
        <label>Search:</label>
        <input id="hexedSearch" type="text" placeholder="hex bytes or text..." />
        <select id="hexedSearchMode">
          <option value="hex">HEX</option>
          <option value="ascii">ASCII</option>
        </select>
        <button id="hexedSearchBtn">Find</button>
        <button id="hexedSearchPrev">◀ Prev</button>
        <button id="hexedSearchNext">Next ▶</button>
        <span id="hexedSearchInfo" class="search-info"></span>
      </div>
      <div class="hexeditor-body">
        <div class="hexeditor-progress-overlay hidden" id="hexedProgress">
          <div class="progress-text" id="hexedProgressText">Loading...</div>
          <div class="progress-bar-outer">
            <div class="progress-bar-inner" id="hexedProgressBar"></div>
          </div>
        </div>
        <div class="hexeditor-viewport" id="hexedViewport">
          <div id="hexedScrollContent"></div>
        </div>
      </div>
      <div class="hexeditor-statusbar">
        <span class="status-item" id="hexedStatusOffset">Offset: -</span>
        <span class="status-item" id="hexedStatusValue">Value: -</span>
        <span class="status-item status-modified" id="hexedStatusModified"></span>
      </div>
    `;

    // Cache DOM references
    this._viewport = this.container.querySelector('#hexedViewport');
    this._scrollContent = this.container.querySelector('#hexedScrollContent');
    this._statusOffset = this.container.querySelector('#hexedStatusOffset');
    this._statusValue = this.container.querySelector('#hexedStatusValue');
    this._statusModified = this.container.querySelector('#hexedStatusModified');
    this._searchInput = this.container.querySelector('#hexedSearch');
    this._searchMode = this.container.querySelector('#hexedSearchMode');
    this._searchInfo = this.container.querySelector('#hexedSearchInfo');
    this._gotoInput = this.container.querySelector('#hexedGoto');
    this._progressOverlay = this.container.querySelector('#hexedProgress');
    this._progressText = this.container.querySelector('#hexedProgressText');
    this._progressBarInner = this.container.querySelector('#hexedProgressBar');
    this._butWrite = this.container.querySelector('#hexedWrite');

    // Event listeners
    this.container.querySelector('#hexedClose').addEventListener('click', () => {
      if (this.hasModifications()) {
        if (!confirm('You have unsaved modifications. Close anyway?')) return;
      }
      this.close();
    });

    this._butWrite.addEventListener('click', () => this._handleWrite());

    this.container.querySelector('#hexedUndoAll').addEventListener('click', () => {
      if (this.modifiedOffsets.size === 0) return;
      if (!confirm(`Undo all ${this.modifiedOffsets.size} modifications?`)) return;
      for (const offset of this.modifiedOffsets) {
        this.data[offset] = this.originalData[offset];
      }
      this.modifiedOffsets.clear();
      this._render();
      this._updateStatus();
    });

    this.container.querySelector('#hexedSearchBtn').addEventListener('click', () => this._doSearch());
    this.container.querySelector('#hexedSearchPrev').addEventListener('click', () => this._navigateSearch(-1));
    this.container.querySelector('#hexedSearchNext').addEventListener('click', () => this._navigateSearch(1));

    this._searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.searchMatches.length > 0) {
          this._navigateSearch(1);
        } else {
          this._doSearch();
        }
      }
    });

    // Clear search on input change
    this._searchInput.addEventListener('input', () => {
      this.searchMatches = [];
      this.currentMatchIdx = -1;
      this._searchInfo.textContent = '';
      this._render();
    });

    this.container.querySelector('#hexedGotoBtn').addEventListener('click', () => this._doGoto());
    this._gotoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._doGoto(); }
    });

    // Virtual scroll
    this._viewport.addEventListener('scroll', () => this._onScroll());

    // Click handler for cells
    this._scrollContent.addEventListener('mousedown', (e) => this._handleCellClick(e));
  }

  // ──────────────────── Layout & Virtual Scroll ────────────────────

  _calculateLayout() {
    if (!this.data) return;
    this._totalRows = Math.ceil(this.data.length / this.bytesPerRow);
    const totalHeight = this._totalRows * this.rowHeight;

    // Set scroll height
    this._scrollContent.style.height = totalHeight + 'px';
    this._scrollContent.style.position = 'relative';

    // Calculate visible rows
    const vpHeight = this._viewport.clientHeight;
    this._visibleCount = Math.ceil(vpHeight / this.rowHeight) + 2; // add buffer
  }

  _onScroll() {
    const scrollTop = this._viewport.scrollTop;
    const newStart = Math.floor(scrollTop / this.rowHeight);
    if (newStart !== this._visibleStart) {
      this._visibleStart = newStart;
      this._render();
    }
  }

  _scrollToOffset(byteOffset) {
    const row = Math.floor(byteOffset / this.bytesPerRow);
    const vpHeight = this._viewport.clientHeight;
    const targetScroll = row * this.rowHeight - vpHeight / 2 + this.rowHeight / 2;
    this._viewport.scrollTop = Math.max(0, targetScroll);
    this._visibleStart = Math.floor(this._viewport.scrollTop / this.rowHeight);
    this._render();
  }

  // ──────────────────── Rendering ────────────────────

  _render() {
    if (!this.data) return;

    const start = Math.max(0, this._visibleStart);
    const end = Math.min(this._totalRows, start + this._visibleCount);

    // Build visible rows
    const fragment = document.createDocumentFragment();

    // Container for positioned rows
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.top = (start * this.rowHeight) + 'px';
    wrapper.style.left = '0';
    wrapper.style.right = '0';

    for (let row = start; row < end; row++) {
      const rowEl = this._createRow(row);
      wrapper.appendChild(rowEl);
    }

    // Replace content (keep scroll height div)
    // Remove old rendered wrapper if present
    const oldWrapper = this._scrollContent.querySelector('.hex-rows-wrapper');
    if (oldWrapper) oldWrapper.remove();
    wrapper.className = 'hex-rows-wrapper';
    this._scrollContent.appendChild(wrapper);
  }

  _createRow(rowIndex) {
    const row = document.createElement('div');
    row.className = 'hexeditor-row';
    const byteStart = rowIndex * this.bytesPerRow;

    // Highlight row if selected offset is in this row
    if (this.selectedOffset >= byteStart && this.selectedOffset < byteStart + this.bytesPerRow) {
      row.classList.add('highlight-row');
    }

    // Address
    const addr = document.createElement('span');
    addr.className = 'hexeditor-addr';
    addr.textContent = (this.baseAddress + byteStart).toString(16).toUpperCase().padStart(8, '0');
    row.appendChild(addr);

    // Hex cells
    const hexDiv = document.createElement('span');
    hexDiv.className = 'hexeditor-hex';

    // Separator
    const sep = document.createElement('span');
    sep.className = 'hexeditor-sep';

    // ASCII cells
    const asciiDiv = document.createElement('span');
    asciiDiv.className = 'hexeditor-ascii';

    const bytesInRow = Math.min(this.bytesPerRow, this.data.length - byteStart);

    for (let i = 0; i < this.bytesPerRow; i++) {
      const offset = byteStart + i;

      // Hex cell
      const hexCell = document.createElement('span');
      hexCell.className = 'hex-cell';
      hexCell.dataset.offset = offset;
      hexCell.dataset.pane = 'hex';

      // ASCII cell
      const asciiCell = document.createElement('span');
      asciiCell.className = 'ascii-cell';
      asciiCell.dataset.offset = offset;
      asciiCell.dataset.pane = 'ascii';

      if (i < bytesInRow) {
        const byte = this.data[offset];
        const hexStr = byte.toString(16).toUpperCase().padStart(2, '0');
        hexCell.textContent = hexStr;

        // Color classes
        if (byte === 0x00) hexCell.classList.add('zero');
        else if (byte === 0xFF) hexCell.classList.add('ff');

        // ASCII char
        if (byte >= 0x20 && byte <= 0x7E) {
          asciiCell.textContent = String.fromCharCode(byte);
        } else {
          asciiCell.textContent = '·';
          asciiCell.classList.add('non-printable');
        }

        // Modified?
        if (this.modifiedOffsets.has(offset)) {
          hexCell.classList.add('modified');
          asciiCell.classList.add('modified');
        }

        // Selected?
        if (offset === this.selectedOffset) {
          hexCell.classList.add('selected');
          asciiCell.classList.add('selected');
        }

        // Search match?
        if (this._isSearchMatch(offset)) {
          hexCell.classList.add('search-match');
          asciiCell.classList.add('search-match');
        }
        if (this._isCurrentSearchMatch(offset)) {
          hexCell.classList.add('search-current');
          asciiCell.classList.add('search-current');
        }
      } else {
        hexCell.textContent = '  ';
        asciiCell.textContent = ' ';
      }

      hexDiv.appendChild(hexCell);
      asciiDiv.appendChild(asciiCell);
    }

    row.appendChild(hexDiv);
    row.appendChild(sep);
    row.appendChild(asciiDiv);
    return row;
  }

  // ──────────────────── Selection & Editing ────────────────────

  _handleCellClick(e) {
    const cell = e.target.closest('[data-offset]');
    if (!cell) return;

    const offset = parseInt(cell.dataset.offset);
    if (isNaN(offset) || offset >= this.data.length) return;

    this.selectedOffset = offset;
    this.editingPane = cell.dataset.pane;
    this.editBuffer = '';
    this._render();
    this._updateStatus();

    // Focus container for key events
    e.preventDefault();
  }

  _handleKeyDown(e) {
    // Only handle when hex editor is visible
    if (this.container.classList.contains('hidden')) return;

    // Don't intercept when focus is in search/goto inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    const offset = this.selectedOffset;
    if (offset < 0 || !this.data) return;

    // Navigation keys
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        this._selectOffset(Math.min(offset + 1, this.data.length - 1));
        return;
      case 'ArrowLeft':
        e.preventDefault();
        this._selectOffset(Math.max(offset - 1, 0));
        return;
      case 'ArrowDown':
        e.preventDefault();
        this._selectOffset(Math.min(offset + this.bytesPerRow, this.data.length - 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        this._selectOffset(Math.max(offset - this.bytesPerRow, 0));
        return;
      case 'PageDown':
        e.preventDefault();
        this._selectOffset(Math.min(offset + this.bytesPerRow * 16, this.data.length - 1));
        return;
      case 'PageUp':
        e.preventDefault();
        this._selectOffset(Math.max(offset - this.bytesPerRow * 16, 0));
        return;
      case 'Home':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this._selectOffset(0);
        }
        return;
      case 'End':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this._selectOffset(this.data.length - 1);
        }
        return;
      case 'Tab':
        e.preventDefault();
        this.editingPane = this.editingPane === 'hex' ? 'ascii' : 'hex';
        this.editBuffer = '';
        this._render();
        return;
    }

    // Editing
    if (this.editingPane === 'hex') {
      this._handleHexEdit(e);
    } else if (this.editingPane === 'ascii') {
      this._handleAsciiEdit(e);
    }
  }

  _handleHexEdit(e) {
    const char = e.key.toLowerCase();
    if (!/^[0-9a-f]$/.test(char)) return;
    e.preventDefault();

    this.editBuffer += char;
    if (this.editBuffer.length === 2) {
      const newByte = parseInt(this.editBuffer, 16);
      this._setByte(this.selectedOffset, newByte);
      this.editBuffer = '';
      // Move to next byte
      this._selectOffset(Math.min(this.selectedOffset + 1, this.data.length - 1));
    } else {
      // Show partial edit feedback – re-render to update status
      this._updateStatus();
    }
  }

  _handleAsciiEdit(e) {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();

    const newByte = e.key.charCodeAt(0);
    if (newByte < 0x20 || newByte > 0x7E) return; // only printable ASCII

    this._setByte(this.selectedOffset, newByte);
    this._selectOffset(Math.min(this.selectedOffset + 1, this.data.length - 1));
  }

  _setByte(offset, value) {
    if (offset < 0 || offset >= this.data.length) return;
    if (this.data[offset] === value && !this.modifiedOffsets.has(offset)) return;

    this.data[offset] = value;

    // Track modification (compare against original)
    if (value !== this.originalData[offset]) {
      this.modifiedOffsets.add(offset);
    } else {
      this.modifiedOffsets.delete(offset);
    }

    this._render();
    this._updateStatus();
  }

  _selectOffset(offset) {
    this.selectedOffset = offset;
    this.editBuffer = '';

    // Ensure visible
    const row = Math.floor(offset / this.bytesPerRow);
    const vpHeight = this._viewport.clientHeight;
    const rowTop = row * this.rowHeight;
    const scrollTop = this._viewport.scrollTop;
    if (rowTop < scrollTop) {
      this._viewport.scrollTop = rowTop;
    } else if (rowTop + this.rowHeight > scrollTop + vpHeight) {
      this._viewport.scrollTop = rowTop + this.rowHeight - vpHeight;
    }

    this._visibleStart = Math.floor(this._viewport.scrollTop / this.rowHeight);
    this._render();
    this._updateStatus();
  }

  // ──────────────────── Search ────────────────────

  _doSearch() {
    const query = this._searchInput.value.trim();
    if (!query) return;

    const mode = this._searchMode.value;
    let searchBytes;

    if (mode === 'hex') {
      // Parse hex string: allow spaces, commas
      const cleaned = query.replace(/[,\s]/g, '');
      if (!/^[0-9a-fA-F]*$/.test(cleaned) || cleaned.length === 0 || cleaned.length % 2 !== 0) {
        this._searchInfo.textContent = 'Invalid hex (e.g. "48 65 6C 6C 6F")';
        return;
      }
      searchBytes = new Uint8Array(cleaned.length / 2);
      for (let i = 0; i < searchBytes.length; i++) {
        searchBytes[i] = parseInt(cleaned.substr(i * 2, 2), 16);
      }
    } else {
      // ASCII mode
      const encoder = new TextEncoder();
      searchBytes = encoder.encode(query);
    }

    if (searchBytes.length === 0) return;

    // Find all occurrences
    this.searchMatches = [];
    for (let i = 0; i <= this.data.length - searchBytes.length; i++) {
      let match = true;
      for (let j = 0; j < searchBytes.length; j++) {
        if (this.data[i + j] !== searchBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        this.searchMatches.push(i);
      }
    }

    this._searchMatchLength = searchBytes.length;

    if (this.searchMatches.length > 0) {
      // Jump to first match at or after current selection
      let idx = this.searchMatches.findIndex(m => m >= this.selectedOffset);
      if (idx === -1) idx = 0;
      this.currentMatchIdx = idx;
      this._searchInfo.textContent = `${idx + 1} / ${this.searchMatches.length} matches`;
      this.selectedOffset = this.searchMatches[idx];
      this._scrollToOffset(this.selectedOffset);
    } else {
      this.currentMatchIdx = -1;
      this._searchInfo.textContent = 'No matches found';
    }

    this._render();
  }

  _navigateSearch(direction) {
    if (this.searchMatches.length === 0) return;

    this.currentMatchIdx += direction;
    if (this.currentMatchIdx >= this.searchMatches.length) this.currentMatchIdx = 0;
    if (this.currentMatchIdx < 0) this.currentMatchIdx = this.searchMatches.length - 1;

    this.selectedOffset = this.searchMatches[this.currentMatchIdx];
    this._searchInfo.textContent = `${this.currentMatchIdx + 1} / ${this.searchMatches.length} matches`;
    this._scrollToOffset(this.selectedOffset);
    this._render();
    this._updateStatus();
  }

  _isSearchMatch(offset) {
    if (this.searchMatches.length === 0) return false;
    const len = this._searchMatchLength || 1;
    return this.searchMatches.some(m => offset >= m && offset < m + len);
  }

  _isCurrentSearchMatch(offset) {
    if (this.currentMatchIdx < 0 || this.currentMatchIdx >= this.searchMatches.length) return false;
    const m = this.searchMatches[this.currentMatchIdx];
    const len = this._searchMatchLength || 1;
    return offset >= m && offset < m + len;
  }

  // ──────────────────── Go To Address ────────────────────

  _doGoto() {
    const val = this._gotoInput.value.trim().replace(/^0x/i, '');
    const addr = parseInt(val, 16);
    if (isNaN(addr)) return;

    // Convert absolute address to offset
    const offset = addr >= this.baseAddress ? addr - this.baseAddress : addr;
    if (offset < 0 || offset >= this.data.length) {
      this._gotoInput.style.borderColor = '#c62828';
      setTimeout(() => { this._gotoInput.style.borderColor = ''; }, 1000);
      return;
    }

    this._selectOffset(offset);
    this._scrollToOffset(offset);
  }

  // ──────────────────── Status Bar ────────────────────

  _updateStatus() {
    if (this.selectedOffset >= 0 && this.selectedOffset < this.data.length) {
      const off = this.selectedOffset;
      const absAddr = this.baseAddress + off;
      const byte = this.data[off];
      const hexStr = byte.toString(16).toUpperCase().padStart(2, '0');
      const dec = byte;
      const bin = byte.toString(2).padStart(8, '0');
      const chr = (byte >= 0x20 && byte <= 0x7E) ? `'${String.fromCharCode(byte)}'` : '-';

      this._statusOffset.textContent = `Offset: 0x${absAddr.toString(16).toUpperCase().padStart(8, '0')} (${off})`;
      
      let valueStr = `Hex: 0x${hexStr} | Dec: ${dec} | Bin: ${bin} | Char: ${chr}`;
      if (this.editBuffer.length > 0) {
        valueStr += ` [typing: ${this.editBuffer}_]`;
      }
      this._statusValue.textContent = valueStr;
    } else {
      this._statusOffset.textContent = 'Offset: -';
      this._statusValue.textContent = 'Value: -';
    }

    if (this.modifiedOffsets.size > 0) {
      this._statusModified.textContent = `● ${this.modifiedOffsets.size} byte(s) modified`;
      this._butWrite.disabled = false;
    } else {
      this._statusModified.textContent = '';
      this._butWrite.disabled = true;
    }
  }

  // ──────────────────── Write Flash ────────────────────

  async _handleWrite() {
    if (this.modifiedOffsets.size === 0) return;
    if (!this.onWriteFlash) {
      alert('Write handler not configured');
      return;
    }

    const count = this.modifiedOffsets.size;
    if (!confirm(`Write ${count} modified byte(s) to flash?\n\nThis will erase and reprogram affected sectors.`)) {
      return;
    }

    try {
      this._butWrite.disabled = true;
      this.showProgress('Writing changes to flash...', 0);
      await this.onWriteFlash(this.data, this.modifiedOffsets);

      // Update original snapshot after successful write
      this.originalData = new Uint8Array(this.data);
      this.modifiedOffsets.clear();
      this._render();
      this._updateStatus();
      this.hideProgress();
    } catch (err) {
      this.hideProgress();
      this._butWrite.disabled = false;
      alert('Write failed: ' + (err.message || err));
    }
  }
}
