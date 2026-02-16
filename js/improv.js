/**
 * Improv Wi-Fi Serial Protocol implementation for esp32tool
 * Based on the Improv Wi-Fi Serial SDK (https://github.com/improv-wifi/sdk-serial-js)
 * Protocol spec: https://www.improv-wifi.com/serial/
 */

// Protocol constants
const SERIAL_PACKET_HEADER = [
  0x49, 0x4d, 0x50, 0x52, 0x4f, 0x56, // "IMPROV"
  1, // protocol version
];

const ImprovSerialMessageType = {
  CURRENT_STATE: 0x01,
  ERROR_STATE: 0x02,
  RPC: 0x03,
  RPC_RESULT: 0x04,
};

const ImprovSerialCurrentState = {
  READY: 0x02,
  PROVISIONING: 0x03,
  PROVISIONED: 0x04,
};

const ImprovSerialErrorState = {
  NO_ERROR: 0x00,
  INVALID_RPC_PACKET: 0x01,
  UNKNOWN_RPC_COMMAND: 0x02,
  UNABLE_TO_CONNECT: 0x03,
  TIMEOUT: 0xfe,
  UNKNOWN_ERROR: 0xff,
};

const ImprovSerialRPCCommand = {
  SEND_WIFI_SETTINGS: 0x01,
  REQUEST_CURRENT_STATE: 0x02,
  REQUEST_INFO: 0x03,
  REQUEST_WIFI_NETWORKS: 0x04,
};

const ERROR_MSGS = {
  0x00: "No error",
  0x01: "Invalid RPC packet",
  0x02: "Unknown RPC command",
  0x03: "Unable to connect",
  0xfe: "Timeout",
  0xff: "Unknown error",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ImprovSerial – communicates with an ESP device using the Improv protocol
 * over an already-opened Web Serial port.
 */
class ImprovSerial extends EventTarget {
  constructor(port, logger) {
    super();
    this.port = port;
    this.logger = logger || { log() {}, error() {}, debug() {} };
    this.info = null;
    this.nextUrl = undefined;
    this.state = undefined;
    this.error = ImprovSerialErrorState.NO_ERROR;
    this._reader = null;
    this._rpcFeedback = null;
  }

  /**
   * Detect Improv Serial, fetch state and device info.
   * @param {number} timeout – ms to wait for the device to respond (default 1000)
   * @returns {Promise<object>} device info
   */
  async initialize(timeout = 1000) {
    this.logger.log("Initializing Improv Serial");
    this._processInput();
    // Give the input processing time to start
    await sleep(1000);
    if (!this._reader) {
      throw new Error("Port is not ready");
    }
    try {
      const statePromise = this.requestCurrentState();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Improv Wi-Fi Serial not detected")), timeout)
      );
      await Promise.race([statePromise, timeoutPromise]);
      await this.requestInfo();
    } catch (err) {
      await this.close();
      throw err;
    }
    return this.info;
  }

  async close() {
    if (!this._reader) return;
    await new Promise((resolve) => {
      this.addEventListener("disconnect", resolve, { once: true });
      this._reader.cancel();
    });
  }

  /**
   * Request current state. If already provisioned, also retrieves the URL.
   */
  async requestCurrentState() {
    let rpcResult;
    try {
      const stateChanged = new Promise((resolve, reject) => {
        this.addEventListener("state-changed", resolve, { once: true });
        // Store reject for cleanup below
        this._stateChangedReject = () => {
          this.removeEventListener("state-changed", resolve);
          reject();
        };
      });
      rpcResult = this._sendRPCWithResponse(
        ImprovSerialRPCCommand.REQUEST_CURRENT_STATE,
        [],
      );
      try {
        await Promise.race([stateChanged, rpcResult.then(() => {})]);
      } catch (err) {
        // rpcResult rejection is the meaningful error
        throw typeof err === "string" ? new Error(err) : err;
      }
    } catch (err) {
      this._rpcFeedback = null;
      throw new Error(`Error fetching current state: ${err}`);
    }

    if (this.state !== ImprovSerialCurrentState.PROVISIONED) {
      this._rpcFeedback = null;
      return;
    }

    const data = await rpcResult;
    this.nextUrl = data[0];
  }

  /**
   * Request device info (firmware, version, chipFamily, name)
   */
  async requestInfo(timeout) {
    const response = await this._sendRPCWithResponse(
      ImprovSerialRPCCommand.REQUEST_INFO,
      [],
      timeout,
    );
    this.info = {
      firmware: response[0],
      version: response[1],
      chipFamily: response[2],
      name: response[3],
    };
  }

  /**
   * Provision WiFi with SSID and password
   */
  async provision(ssid, password, timeout) {
    const encoder = new TextEncoder();
    const ssidEncoded = encoder.encode(ssid);
    const pwEncoded = encoder.encode(password);
    const data = [
      ssidEncoded.length,
      ...ssidEncoded,
      pwEncoded.length,
      ...pwEncoded,
    ];
    const response = await this._sendRPCWithResponse(
      ImprovSerialRPCCommand.SEND_WIFI_SETTINGS,
      data,
      timeout,
    );
    this.nextUrl = response[0];
  }

  /**
   * Scan for available WiFi networks
   * @returns {Promise<Array<{name: string, rssi: number, secured: boolean}>>}
   */
  async scan() {
    const results = await this._sendRPCWithMultipleResponses(
      ImprovSerialRPCCommand.REQUEST_WIFI_NETWORKS,
      [],
    );
    const ssids = results.map(([name, rssi, secured]) => ({
      name,
      rssi: parseInt(rssi),
      secured: secured === "YES",
    }));
    ssids.sort((a, b) =>
      a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()),
    );
    return ssids;
  }

  // ─── Private methods ────────────────────────────────────────────

  _sendRPC(command, data) {
    this.writePacketToStream(ImprovSerialMessageType.RPC, [
      command,
      data.length,
      ...data,
    ]);
  }

  async _sendRPCWithResponse(command, data, timeout) {
    if (this._rpcFeedback) {
      throw new Error("Only 1 RPC command that requires feedback can be active");
    }
    return await this._awaitRPCResultWithTimeout(
      new Promise((resolve, reject) => {
        this._rpcFeedback = { command, resolve, reject };
        this._sendRPC(command, data);
      }),
      timeout,
    );
  }

  async _sendRPCWithMultipleResponses(command, data, timeout) {
    if (this._rpcFeedback) {
      throw new Error("Only 1 RPC command that requires feedback can be active");
    }
    return await this._awaitRPCResultWithTimeout(
      new Promise((resolve, reject) => {
        this._rpcFeedback = { command, resolve, reject, receivedData: [] };
        this._sendRPC(command, data);
      }),
      timeout,
    );
  }

  async _awaitRPCResultWithTimeout(sendRPCPromise, timeout) {
    if (!timeout) return await sendRPCPromise;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this._setError(ImprovSerialErrorState.TIMEOUT),
        timeout,
      );
      sendRPCPromise.finally(() => clearTimeout(timer));
      sendRPCPromise.then(resolve, reject);
    });
  }

  async _processInput() {
    this.logger.debug("Starting Improv read loop");
    this._reader = this.port.readable.getReader();

    try {
      let line = [];
      let isImprov; // undefined = not sure
      let improvLength = 0;

      while (true) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        for (const byte of value) {
          if (isImprov === false) {
            if (byte === 10) isImprov = undefined;
            continue;
          }

          if (isImprov === true) {
            line.push(byte);
            if (line.length === improvLength) {
              this._handleIncomingPacket(line);
              isImprov = undefined;
              line = [];
            }
            continue;
          }

          if (byte === 10) {
            line = [];
            continue;
          }

          line.push(byte);

          if (line.length !== 9) continue;

          // Check if it's improv header
          isImprov = String.fromCharCode(...line.slice(0, 6)) === "IMPROV";
          if (!isImprov) {
            line = [];
            continue;
          }
          // Format: IMPROV <VERSION> <TYPE> <LENGTH> <DATA> <CHECKSUM>
          const packetLength = line[8];
          improvLength = 9 + packetLength + 1; // header + data + checksum
        }
      }
    } catch (err) {
      this.logger.error("Error while reading serial port", err);
    } finally {
      this._reader.releaseLock();
      this._reader = null;
    }

    this.logger.debug("Finished Improv read loop");
    this.dispatchEvent(new Event("disconnect"));
  }

  _handleIncomingPacket(line) {
    const payload = line.slice(6);
    const version = payload[0];
    const packetType = payload[1];
    const packetLength = payload[2];
    const data = payload.slice(3, 3 + packetLength);

    this.logger.debug("IMPROV PACKET", { version, packetType, packetLength, data });

    if (version !== 1) {
      this.logger.error("Received unsupported Improv version", version);
      return;
    }

    // Verify checksum
    const packetChecksum = payload[3 + packetLength];
    let calculatedChecksum = 0;
    for (let i = 0; i < line.length - 1; i++) {
      calculatedChecksum += line[i];
    }
    calculatedChecksum = calculatedChecksum & 0xff;
    if (calculatedChecksum !== packetChecksum) {
      this.logger.error(
        `Invalid checksum ${packetChecksum}, expected ${calculatedChecksum}`,
      );
      return;
    }

    if (packetType === ImprovSerialMessageType.CURRENT_STATE) {
      this.state = data[0];
      this.dispatchEvent(
        new CustomEvent("state-changed", { detail: this.state }),
      );
    } else if (packetType === ImprovSerialMessageType.ERROR_STATE) {
      this._setError(data[0]);
    } else if (packetType === ImprovSerialMessageType.RPC_RESULT) {
      if (!this._rpcFeedback) {
        this.logger.error("Received RPC result while not waiting for one");
        return;
      }
      const rpcCommand = data[0];
      if (rpcCommand !== this._rpcFeedback.command) {
        this.logger.error(
          `Received result for command ${rpcCommand} but expected ${this._rpcFeedback.command}`,
        );
        return;
      }

      // Parse TLV-encoded strings
      const result = [];
      const totalLength = data[1];
      let idx = 2;
      while (idx < 2 + totalLength) {
        const strLen = data[idx];
        result.push(
          String.fromCodePoint(...data.slice(idx + 1, idx + strLen + 1)),
        );
        idx += strLen + 1;
      }

      if ("receivedData" in this._rpcFeedback) {
        if (result.length > 0) {
          this._rpcFeedback.receivedData.push(result);
        } else {
          // Empty result = done
          this._rpcFeedback.resolve(this._rpcFeedback.receivedData);
          this._rpcFeedback = null;
        }
      } else {
        this._rpcFeedback.resolve(result);
        this._rpcFeedback = null;
      }
    } else {
      this.logger.error("Unable to handle Improv packet", payload);
    }
  }

  /**
   * Write a packet to the serial stream with header and checksum
   */
  async writePacketToStream(type, data) {
    const payload = new Uint8Array([
      ...SERIAL_PACKET_HEADER,
      type,
      data.length,
      ...data,
      0, // checksum placeholder
      0, // newline placeholder
    ]);
    // Calculate checksum (sum of all bytes except last two, & 0xFF)
    payload[payload.length - 2] =
      payload.reduce((sum, cur) => sum + cur, 0) & 0xff;
    payload[payload.length - 1] = 10; // Newline

    this.logger.debug("Writing Improv packet:", payload);
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(payload);
    } finally {
      try {
        writer.releaseLock();
      } catch (err) {
        console.error("Ignoring release lock error", err);
      }
    }
  }

  _setError(error) {
    this.error = error;
    if (error > 0 && this._rpcFeedback) {
      this._rpcFeedback.reject(ERROR_MSGS[error] || `UNKNOWN_ERROR (${error})`);
      this._rpcFeedback = null;
    }
    this.dispatchEvent(
      new CustomEvent("error-changed", { detail: this.error }),
    );
  }
}

// ─── Improv Dialog UI ──────────────────────────────────────────────

const improvDialogStyles = `
  .improv-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: improv-fadein 0.2s ease;
  }
  @keyframes improv-fadein {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .improv-dialog {
    background: #2a2a2a;
    color: #ddd;
    border-radius: 8px;
    padding: 0;
    min-width: 340px;
    max-width: 440px;
    width: 90vw;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    overflow: hidden;
  }
  .improv-dialog-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    background: #333;
    border-bottom: 1px solid #444;
  }
  .improv-dialog-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  .improv-dialog-close {
    background: none;
    border: none;
    color: #999;
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .improv-dialog-close:hover {
    color: #fff;
  }
  .improv-dialog-body {
    padding: 20px;
  }
  .improv-status {
    text-align: center;
    padding: 20px 0;
    color: #aaa;
  }
  .improv-spinner {
    display: inline-block;
    width: 24px;
    height: 24px;
    border: 3px solid #555;
    border-top-color: #4fc3f7;
    border-radius: 50%;
    animation: improv-spin 0.8s linear infinite;
    margin-bottom: 12px;
  }
  @keyframes improv-spin {
    to { transform: rotate(360deg); }
  }
  .improv-info-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 16px;
    margin-bottom: 16px;
  }
  .improv-info-label {
    color: #999;
    font-size: 13px;
  }
  .improv-info-value {
    color: #eee;
    font-size: 13px;
    word-break: break-all;
  }
  .improv-state-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 500;
  }
  .improv-state-ready {
    background: #2e7d32;
    color: #c8e6c9;
  }
  .improv-state-provisioning {
    background: #f57f17;
    color: #fff9c4;
  }
  .improv-state-provisioned {
    background: #1565c0;
    color: #bbdefb;
  }
  .improv-actions {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 16px;
  }
  .improv-btn {
    padding: 18px 24px;
    border: 1px solid #555;
    border-radius: 6px;
    background: #444;
    color: #ddd;
    cursor: pointer;
    font-size: 14px;
    font-family: inherit;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 12px;
    transition: background 0.15s;
  }
  .improv-btn:hover:not(:disabled) {
    background: #555;
  }
  .improv-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .improv-btn-primary {
    background: #1976d2;
    border-color: #1565c0;
    color: #fff;
  }
  .improv-btn-primary:hover:not(:disabled) {
    background: #1e88e5;
  }
  .improv-btn-icon {
    font-size: 22px;
    width: 28px;
    text-align: center;
    flex-shrink: 0;
  }
  .improv-btn-text {
    flex: 1;
  }
  .improv-btn-text small {
    display: block;
    color: #aaa;
    font-size: 12px;
    margin-top: 3px;
  }
  .improv-wifi-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .improv-wifi-form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    color: #aaa;
  }
  .improv-wifi-form input,
  .improv-wifi-form select {
    padding: 8px 12px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #1c1c1c;
    color: #ddd;
    font-size: 14px;
    font-family: inherit;
    outline: none;
  }
  .improv-wifi-form input:focus,
  .improv-wifi-form select:focus {
    border-color: #4fc3f7;
  }
  .improv-wifi-form select {
    appearance: auto;
  }
  .improv-wifi-buttons {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  .improv-wifi-buttons .improv-btn {
    flex: 1;
    justify-content: center;
  }
  .improv-error {
    background: #d32f2f;
    color: #fff;
    padding: 10px 14px;
    border-radius: 4px;
    margin-top: 12px;
    font-size: 13px;
  }
  .improv-success {
    background: #2e7d32;
    color: #c8e6c9;
    padding: 10px 14px;
    border-radius: 4px;
    margin-top: 12px;
    font-size: 13px;
  }
  .improv-section-title {
    font-size: 13px;
    color: #999;
    margin: 16px 0 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
`;

/**
 * ImprovDialog – manages the modal dialog UI for Improv interactions.
 * Constructed with a serial port reference.
 */
export class ImprovDialog {
  constructor(port) {
    this.port = port;
    this.client = null;
    this.overlay = null;
    this._view = "loading"; // loading | dashboard | wifi | error
    this._ssids = null;
    this._selectedSsid = null;
    this._errorMsg = null;
    this._successMsg = null;
    this._busy = false;
  }

  /**
   * Open the Improv dialog, try to connect to the device.
   * Must first disconnect the console reader so Improv can read the port.
   * Returns a promise that resolves when the dialog is closed.
   * @param {Function} disconnectConsole – async fn to disconnect the console reader
   * @param {Function} reconnectConsole – async fn to reconnect the console reader
   */
  async open(disconnectConsole, reconnectConsole) {
    this._disconnectConsole = disconnectConsole;
    this._reconnectConsole = reconnectConsole;

    // Disconnect console reader so we can use the port
    if (disconnectConsole) {
      await disconnectConsole();
    }

    // Create overlay
    this._injectStyles();
    this.overlay = document.createElement("div");
    this.overlay.className = "improv-overlay";
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.body.appendChild(this.overlay);

    // Show loading view
    this._view = "loading";
    this._render();

    // Attempt to initialize Improv
    try {
      const logger = {
        log: (...args) => console.log("[Improv]", ...args),
        error: (...args) => console.error("[Improv]", ...args),
        debug: (...args) => console.debug("[Improv]", ...args),
      };

      this.client = new ImprovSerial(this.port, logger);
      const info = await this.client.initialize(3000);

      // If provisioned, poll for valid URL (not 0.0.0.0)
      if (this.client.state === ImprovSerialCurrentState.PROVISIONED) {
        const startTime = Date.now();
        while (Date.now() - startTime < 10000) {
          await this.client.requestCurrentState();
          if (this.client.nextUrl && !this.client.nextUrl.includes("0.0.0.0")) {
            break;
          }
          await sleep(500);
        }
      }

      this._view = "dashboard";
      this._render();
    } catch (err) {
      console.error("[Improv] Init failed:", err);
      this._view = "error";
      this._errorMsg = "Improv not detected. Make sure the device firmware supports Improv Wi-Fi.";
      this._render();
    }

    // Return a promise that resolves when dialog closes
    return new Promise((resolve) => {
      this._closeResolve = resolve;
    });
  }

  async close() {
    // Close Improv client
    if (this.client) {
      try {
        await this.client.close();
      } catch (e) {
        console.error("[Improv] Close error:", e);
      }
      this.client = null;
    }

    // Remove overlay
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }

    // Reconnect console reader
    if (this._reconnectConsole) {
      await sleep(200);
      await this._reconnectConsole();
    }

    if (this._closeResolve) {
      this._closeResolve();
      this._closeResolve = null;
    }
  }

  _injectStyles() {
    if (document.getElementById("improv-dialog-styles")) return;
    const style = document.createElement("style");
    style.id = "improv-dialog-styles";
    style.textContent = improvDialogStyles;
    document.head.appendChild(style);
  }

  _render() {
    if (!this.overlay) return;
    let body = "";

    switch (this._view) {
      case "loading":
        body = this._renderLoading();
        break;
      case "dashboard":
        body = this._renderDashboard();
        break;
      case "wifi":
        body = this._renderWifi();
        break;
      case "error":
        body = this._renderError();
        break;
    }

    this.overlay.innerHTML = `
      <div class="improv-dialog">
        <div class="improv-dialog-header">
          <h3>${this._getTitle()}</h3>
          <button class="improv-dialog-close" title="Close">&times;</button>
        </div>
        <div class="improv-dialog-body">
          ${body}
        </div>
      </div>
    `;

    // Bind close button
    this.overlay.querySelector(".improv-dialog-close")
      .addEventListener("click", () => this.close());

    // Bind view-specific events
    this._bindEvents();
  }

  _getTitle() {
    switch (this._view) {
      case "loading": return "Improv Wi-Fi";
      case "dashboard": return this._esc(this.client?.info?.name || "Device");
      case "wifi": return "Wi-Fi Configuration";
      case "error": return "Improv Wi-Fi";
    }
  }

  _renderLoading() {
    return `
      <div class="improv-status">
        <div class="improv-spinner"></div>
        <div>Connecting to device...</div>
      </div>
    `;
  }

  _renderDashboard() {
    const info = this.client?.info;
    const state = this.client?.state;
    const nextUrl = this.client?.nextUrl;

    let stateLabel = "Unknown";
    let stateClass = "";
    if (state === ImprovSerialCurrentState.READY) {
      stateLabel = "Ready";
      stateClass = "improv-state-ready";
    } else if (state === ImprovSerialCurrentState.PROVISIONING) {
      stateLabel = "Provisioning...";
      stateClass = "improv-state-provisioning";
    } else if (state === ImprovSerialCurrentState.PROVISIONED) {
      stateLabel = "Connected";
      stateClass = "improv-state-provisioned";
    }

    const wifiLabel = state === ImprovSerialCurrentState.PROVISIONED
      ? "Change Wi-Fi" : "Connect to Wi-Fi";
    const wifiDesc = state === ImprovSerialCurrentState.PROVISIONED
      ? "Change the Wi-Fi network" : "Configure Wi-Fi credentials";

    let html = `
      <div class="improv-section-title">Device Info</div>
      <div class="improv-info-grid">
        <span class="improv-info-label">Name</span>
        <span class="improv-info-value">${this._esc(info?.name || "–")}</span>
        <span class="improv-info-label">Firmware</span>
        <span class="improv-info-value">${this._esc(info?.firmware || "–")}</span>
        <span class="improv-info-label">Version</span>
        <span class="improv-info-value">${this._esc(info?.version || "–")}</span>
        <span class="improv-info-label">Chip</span>
        <span class="improv-info-value">${this._esc(info?.chipFamily || "–")}</span>
        <span class="improv-info-label">Status</span>
        <span class="improv-info-value"><span class="improv-state-badge ${stateClass}">${stateLabel}</span></span>
      </div>

      <div class="improv-section-title">Actions</div>
      <div class="improv-actions">
        <button class="improv-btn improv-btn-primary" id="improv-wifi-btn">
          <span class="improv-btn-icon">📶</span>
          <span class="improv-btn-text">
            ${wifiLabel}
            <small>${wifiDesc}</small>
          </span>
        </button>
    `;

    if (nextUrl) {
      html += `
        <button class="improv-btn" id="improv-visit-btn">
          <span class="improv-btn-icon">🌐</span>
          <span class="improv-btn-text">
            Visit Device
            <small>${this._esc(nextUrl)}</small>
          </span>
        </button>
      `;
    }

    html += `</div>`;

    if (this._successMsg) {
      html += `<div class="improv-success">${this._esc(this._successMsg)}</div>`;
    }

    return html;
  }

  _renderWifi() {
    if (this._busy) {
      const busyMsg = this._ssids === undefined
        ? "Scanning for networks..."
        : "Connecting...";
      return `
        <div class="improv-status">
          <div class="improv-spinner"></div>
          <div>${busyMsg}</div>
        </div>
      `;
    }

    let ssidInput = "";
    if (this._ssids && this._ssids.length > 0) {
      const options = this._ssids.map((s) => {
        const signal = s.rssi > -50 ? "▂▄▆█" : s.rssi > -70 ? "▂▄▆" : s.rssi > -80 ? "▂▄" : "▂";
        const lock = s.secured ? "🔒" : "";
        const sel = s.name === this._selectedSsid ? " selected" : "";
        return `<option value="${this._esc(s.name)}"${sel}>${this._esc(s.name)} ${signal} ${lock}</option>`;
      });
      options.push(`<option value="">Join other network...</option>`);
      ssidInput = `
        <label>
          Network
          <select id="improv-ssid-select">${options.join("")}</select>
        </label>
        <div id="improv-custom-ssid" style="display:none">
          <label>
            SSID
            <input type="text" id="improv-ssid-input" placeholder="Network name">
          </label>
        </div>
      `;
    } else {
      // No scan results or scan not supported
      ssidInput = `
        <label>
          SSID
          <input type="text" id="improv-ssid-input" value="${this._esc(this._selectedSsid || "")}" placeholder="Network name">
        </label>
      `;
    }

    let html = `
      <div class="improv-wifi-form">
        ${ssidInput}
        <label>
          Password
          <input type="password" id="improv-password-input" placeholder="Wi-Fi password">
        </label>
        <div class="improv-wifi-buttons">
          <button class="improv-btn" id="improv-wifi-back">Back</button>
          <button class="improv-btn improv-btn-primary" id="improv-wifi-connect">Connect</button>
        </div>
      </div>
    `;

    if (this._errorMsg) {
      html += `<div class="improv-error">${this._esc(this._errorMsg)}</div>`;
    }

    return html;
  }

  _renderError() {
    return `
      <div class="improv-status">
        <div style="font-size: 32px; margin-bottom: 12px;">⚠️</div>
        <div>${this._esc(this._errorMsg || "An error occurred")}</div>
      </div>
      <div class="improv-actions">
        <button class="improv-btn" id="improv-error-close">Close</button>
      </div>
    `;
  }

  _bindEvents() {
    const bind = (id, event, handler) => {
      const el = this.overlay?.querySelector(`#${id}`);
      if (el) el.addEventListener(event, handler);
    };

    bind("improv-wifi-btn", "click", () => this._showWifi());
    bind("improv-visit-btn", "click", () => this._visitDevice());
    bind("improv-wifi-back", "click", () => this._backToDashboard());
    bind("improv-wifi-connect", "click", () => this._doProvision());
    bind("improv-error-close", "click", () => this.close());

    // SSID select change handler
    const ssidSelect = this.overlay?.querySelector("#improv-ssid-select");
    if (ssidSelect) {
      ssidSelect.addEventListener("change", () => {
        const customDiv = this.overlay?.querySelector("#improv-custom-ssid");
        if (ssidSelect.value === "") {
          if (customDiv) customDiv.style.display = "block";
          this._selectedSsid = null;
        } else {
          if (customDiv) customDiv.style.display = "none";
          this._selectedSsid = ssidSelect.value;
        }
      });
    }

    // Enter key in password field
    const pwInput = this.overlay?.querySelector("#improv-password-input");
    if (pwInput) {
      pwInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this._doProvision();
        }
      });
    }
  }

  async _showWifi() {
    this._view = "wifi";
    this._errorMsg = null;
    this._successMsg = null;
    this._ssids = undefined; // undefined = not loaded
    this._selectedSsid = null;
    this._busy = true;
    this._render();

    // Scan for networks
    try {
      const ssids = await this.client.scan();
      this._ssids = ssids;
      this._selectedSsid = ssids.length > 0 ? ssids[0].name : null;
    } catch (err) {
      console.warn("[Improv] WiFi scan failed:", err);
      this._ssids = null;
      this._selectedSsid = null;
    }

    this._busy = false;
    this._render();
  }

  _visitDevice() {
    const url = this.client?.nextUrl;
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          window.open(url, "_blank", "noopener");
        } else {
          console.warn("[Improv] Blocked non-HTTP URL:", url);
        }
      } catch {
        console.warn("[Improv] Invalid URL:", url);
      }
    }
  }

  _backToDashboard() {
    this._view = "dashboard";
    this._errorMsg = null;
    this._render();
  }

  async _doProvision() {
    const ssidSelect = this.overlay?.querySelector("#improv-ssid-select");
    const ssidInput = this.overlay?.querySelector("#improv-ssid-input");

    let ssid;
    if (ssidSelect && ssidSelect.value !== "") {
      ssid = ssidSelect.value;
    } else if (ssidInput) {
      ssid = ssidInput.value.trim();
    }

    const password = this.overlay?.querySelector("#improv-password-input")?.value || "";

    if (!ssid) {
      this._errorMsg = "Please enter or select a network name.";
      this._render();
      return;
    }

    this._errorMsg = null;
    this._busy = true;
    this._render();

    try {
      await this.client.provision(ssid, password, 30000);

      // Poll for valid URL after provisioning
      const startTime = Date.now();
      while (Date.now() - startTime < 10000) {
        try {
          await this.client.requestCurrentState();
        } catch (e) {
          // Ignore polling errors
        }
        if (this.client.nextUrl && !this.client.nextUrl.includes("0.0.0.0")) {
          break;
        }
        await sleep(500);
      }

      this._busy = false;
      this._successMsg = `Successfully connected to "${ssid}"!`;
      this._view = "dashboard";
      this._render();
    } catch (err) {
      this._busy = false;
      this._errorMsg = `Failed to connect: ${err}`;
      this._render();
    }
  }

  _esc(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}

export { ImprovSerial, ImprovSerialCurrentState, ImprovSerialErrorState };
