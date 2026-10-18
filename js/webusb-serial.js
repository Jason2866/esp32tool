/**
 * WebUSBSerial - Web Serial API-like wrapper for WebUSB
 * Provides a familiar interface for serial communication over USB
 *
 * This enables to work on Android devices where Web Serial API
 * is not available but WebUSB is supported. It can also be used on Desktop.
 *
 * IMPORTANT: For Android compatibility, this class uses smaller transfer sizes
 * to prevent SLIP synchronization errors. The maxTransferSize is set to 64 bytes
 * (or endpoint packetSize if smaller) to ensure SLIP frames don't get split.
 * On Desktop, larger transfer sizes are used for better performance.
 */
import { serialPortFilters, webUSBDeviceFilters } from "./util/usb-chips.js";

class WebUSBSerial {
  constructor(logger = null, isAndroid = false) {
    this.device = null;
    this.interfaceNumber = null;
    this.endpointIn = null;
    this.endpointOut = null;
    this.controlInterface = null;
    this.readableStream = null;
    this.writableStream = null;
    this._readLoopRunning = false;
    this._usbDisconnectHandler = null;
    this._eventListeners = {
      close: [],
      disconnect: [],
    };

    // Flag to indicate if running on Android (affects maxTransferSize)
    this.isAndroid = isAndroid;

    // Transfer size optimized for WebUSB
    // CRITICAL: blockSize = (maxTransferSize - 2) / 2
    // On Android: Set to 64 bytes for maximum compatibility (Andoid does not support more!)
    // On Desktop: Set to 512 bytes for better performance (seems max. value for Desktop)
    if (this.isAndroid) {
      this.maxTransferSize = 64; // Android: blockSize = (64-2)/2 = 31 bytes per SLIP packet
    } else {
      this.maxTransferSize = 512; // Desktop: blockSize = (512-2)/2 = 255 bytes per SLIP packet
    }

    // Flag to indicate this is WebUSB (used by esptool to adjust block sizes)
    this.isWebUSB = true;

    // Command queue for serializing control transfers (critical for CP2102)
    this._commandQueue = Promise.resolve();

    // Track current DTR/RTS state to preserve unspecified signals
    this._currentDTR = false;
    this._currentRTS = false;

    // Logger function (defaults to console.log if not provided)
    this._log = logger || ((...args) => console.log(...args));
  }

  /**
   * Request USB device (mimics navigator.serial.requestPort())
   * @param {function|object} logger - Logger function or object with log() method
   * @param {boolean} forceNew - If true, forces selection of a new device (ignores already paired devices)
   * @param {boolean} isAndroid - If true, indicates this is running on Android (affects maxTransferSize)
   */
  static async requestPort(
    logger = null,
    forceNew = false,
    isAndroid = typeof navigator !== "undefined" &&
      /Android/i.test(navigator.userAgent || ""),
  ) {
    const filters = webUSBDeviceFilters;

    // Helper to call logger (supports both function and object with log() method)
    const log = (msg) => {
      if (!logger) return;
      if (typeof logger === "function") {
        logger(msg);
      } else if (typeof logger.log === "function") {
        logger.log(msg);
      }
    };

    let device;

    // If forceNew is false, try to reuse a previously authorized device
    if (!forceNew && navigator.usb && navigator.usb.getDevices) {
      try {
        const devices = await navigator.usb.getDevices();
        // Find a device that matches our filters
        device = devices.find((d) =>
          filters.some((f) => f.vendorId === d.vendorId),
        );

        if (device) {
          log("[WebUSB] Reusing previously authorized device");
        }
      } catch (err) {
        // Can't use this._log in static method, use console as fallback
        console.warn(
          "[WebUSB] Failed to get previously authorized devices:",
          err,
        );
      }
    }

    // If no device found or forceNew is true, request a new device
    if (!device) {
      if (!navigator.usb) {
        throw new Error("WebUSB not available");
      }
      device = await navigator.usb.requestDevice({ filters });
    }

    const port = new WebUSBSerial(logger, isAndroid);
    port.device = device;
    return port;
  }

  /**
   * Open the USB device (mimics port.open())
   */
  async open(options = {}) {
    if (!this.device) {
      throw new Error("No device selected");
    }

    const baudRate = options.baudRate || 115200;

    // If device is already opened, we need to close and reopen it
    // This is critical for ESP32-S2 which changes interfaces when switching modes
    if (this.device.opened) {
      try {
        // Release all interfaces
        if (this.interfaceNumber !== null) {
          try {
            await this.device.releaseInterface(this.interfaceNumber);
          } catch (e) {}
        }
        if (
          this.controlInterface !== null &&
          this.controlInterface !== this.interfaceNumber
        ) {
          try {
            await this.device.releaseInterface(this.controlInterface);
          } catch (e) {}
        }

        // Close the device
        await this.device.close();

        // Reset interface numbers so they get re-scanned
        this.interfaceNumber = null;
        this.controlInterface = null;
        this.endpointIn = null;
        this.endpointOut = null;

        // Wait a bit for device to settle
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (e) {
        this._log("[WebUSB] Error during close:", e.message);
      }
    }

    if (this.device.opened) {
      try {
        await this.device.close();
      } catch (e) {
        this._log("[WebUSB] Error closing device:", e.message);
      }
    }

    try {
      if (this.device.reset) {
        await this.device.reset();
      }
    } catch (e) {
      //            this._log('[WebUSB] Device reset failed:', e.message);
    }

    const attemptOpenAndClaim = async () => {
      await this.device.open();
      try {
        const currentCfg = this.device.configuration
          ? this.device.configuration.configurationValue
          : null;
        if (!currentCfg || currentCfg !== 1) {
          await this.device.selectConfiguration(1);
        }
      } catch (e) {}

      const config = this.device.configuration;

      // Try to claim CDC control interface first (helps on Android/CH34x)
      const preControlIface = config.interfaces.find(
        (i) =>
          i.alternates &&
          i.alternates[0] &&
          i.alternates[0].interfaceClass === 0x02,
      );
      if (preControlIface) {
        try {
          await this.device.claimInterface(preControlIface.interfaceNumber);
          try {
            await this.device.selectAlternateInterface(
              preControlIface.interfaceNumber,
              0,
            );
          } catch (e) {}
          this.controlInterface = preControlIface.interfaceNumber;
        } catch (e) {
          if (this.device.vendorId !== 0x1a86) {
            this._log(`[WebUSB] Info: Could not pre-claim CDC control iface.`);
          }
        }
      }

      // Find bulk IN/OUT interface (prefer CDC data class)
      const candidates = [];
      for (const iface of config.interfaces) {
        // Check all alternates, not just alternates[0]
        for (let altIndex = 0; altIndex < iface.alternates.length; altIndex++) {
          const alt = iface.alternates[altIndex];
          let hasIn = false,
            hasOut = false;
          for (const ep of alt.endpoints) {
            if (ep.type === "bulk" && ep.direction === "in") hasIn = true;
            if (ep.type === "bulk" && ep.direction === "out") hasOut = true;
          }
          if (hasIn && hasOut) {
            let score = 2;
            if (alt.interfaceClass === 0x0a)
              score = 0; // CDC data first
            else if (alt.interfaceClass === 0xff) score = 1; // vendor-specific next
            candidates.push({ iface, altIndex, alt, score });
            break; // Found suitable alternate for this interface
          }
        }
      }

      if (!candidates.length) {
        throw new Error("No suitable USB interface found");
      }

      candidates.sort((a, b) => a.score - b.score);
      let lastErr = null;
      for (const cand of candidates) {
        try {
          // CORRECT ORDER per WebUSB spec: claimInterface FIRST, then selectAlternateInterface
          await this.device.claimInterface(cand.iface.interfaceNumber);
          try {
            await this.device.selectAlternateInterface(
              cand.iface.interfaceNumber,
              cand.altIndex,
            );
          } catch (e) {
            this._log(`[WebUSB] selectAlternateInterface failed: ${e.message}`);
          }
          this.interfaceNumber = cand.iface.interfaceNumber;

          // Use the alternate that was found to have bulk endpoints
          for (const ep of cand.alt.endpoints) {
            if (ep.type === "bulk" && ep.direction === "in") {
              this.endpointIn = ep.endpointNumber;
            } else if (ep.type === "bulk" && ep.direction === "out") {
              this.endpointOut = ep.endpointNumber;
            }
          }

          // Validate that both endpoints were found
          if (this.endpointIn == null || this.endpointOut == null) {
            throw new Error(
              `Missing bulk endpoints (in=${this.endpointIn}, out=${this.endpointOut})`,
            );
          }

          // Use endpoint packet size for transfer length (Android prefers max-packet)
          try {
            const inEp = cand.alt.endpoints.find(
              (ep) => ep.type === "bulk" && ep.direction === "in",
            );
            if (inEp && inEp.packetSize) {
              // Don't limit by packetSize - use our optimized value
            } else {
              this._log(
                `[WebUSB] No packetSize found, keeping maxTransferSize=${this.maxTransferSize}`,
              );
            }
          } catch (e) {
            // Suppress packetSize check error - not critical
          }

          return config;
        } catch (claimErr) {
          lastErr = claimErr;
          // Suppress claim failed message - this is expected when trying multiple interfaces
        }
      }

      throw lastErr || new Error("Unable to claim any USB interface");
    };

    let config;
    try {
      config = await attemptOpenAndClaim();
    } catch (err) {
      this._log(
        "[WebUSB] open/claim failed, retrying after reset:",
        err.message,
      );
      try {
        if (this.device.reset) {
          await this.device.reset();
        }
      } catch (e) {}
      try {
        await this.device.close();
      } catch (e) {}
      try {
        config = await attemptOpenAndClaim();
      } catch (err2) {
        throw new Error(`Unable to claim USB interface: ${err2.message}`);
      }
    }

    // Claim control interface if not already claimed
    if (this.controlInterface == null) {
      const controlIface = config.interfaces.find(
        (i) =>
          i.alternates[0].interfaceClass === 0x02 &&
          i.interfaceNumber !== this.interfaceNumber,
      );

      if (controlIface) {
        try {
          await this.device.claimInterface(controlIface.interfaceNumber);
          try {
            await this.device.selectAlternateInterface(
              controlIface.interfaceNumber,
              0,
            );
          } catch (e) {}
          this.controlInterface = controlIface.interfaceNumber;
        } catch (_e) {
          // On macOS, CDC control interface 0 is claimed by AppleUSBCDCACM.
          // For WCH devices (CH343/CH9102), vendor request 0xA4 to device endpoint 0 is used.
          this.controlInterface = this.interfaceNumber;
          if (this.device.vendorId !== 0x1a86) {
            this._log(
              `[WebUSB] Warning: Could not claim CDC control interface ${controlIface.interfaceNumber}.`,
            );
          }
        }
      } else {
        this.controlInterface = this.interfaceNumber;
      }
    }

    // CP2102-specific initialization sequence (must be in this exact order!)
    if (this.device.vendorId === 0x10c4) {
      try {
        // Step 1: Enable UART interface
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x00, // IFC_ENABLE
          value: 0x01, // UART_ENABLE
          index: 0x00,
        });

        // Step 2: Set line control (8N1: 8 data bits, no parity, 1 stop bit)
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x03, // SET_LINE_CTL
          value: 0x0800, // 8 data bits, no parity, 1 stop bit
          index: 0x00,
        });

        // Step 3: Set DTR/RTS signals (vendor-specific for CP2102)
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x07, // SET_MHS
          value: 0x03 | 0x0100 | 0x0200, // DTR=1, RTS=1 with masks
          index: 0x00,
        });

        // Step 4: Set baudrate (vendor-specific for CP2102)
        // Use IFC_SET_BAUDRATE (0x1E) with direct 32-bit baudrate value
        const baudrateBuffer = new ArrayBuffer(4);
        const baudrateView = new DataView(baudrateBuffer);
        baudrateView.setUint32(0, baudRate, true); // little-endian

        await this.device.controlTransferOut(
          {
            requestType: "vendor",
            recipient: "interface",
            request: 0x1e, // IFC_SET_BAUDRATE
            value: 0,
            index: 0,
          },
          baudrateBuffer,
        );
      } catch (e) {
        this._log("[WebUSB CP2102] Initialization error:", e.message);
      }
    }
    // FTDI-specific initialization sequence
    else if (this.device.vendorId === 0x0403) {
      try {
        // Step 1: Reset device
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x00, // SIO_RESET
          value: 0x00, // Reset
          index: 0x00,
        });

        // Step 2: Set flow control to none
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x02, // SIO_SET_FLOW_CTRL
          value: 0x00, // No flow control
          index: 0x00,
        });

        // Step 3: Set data characteristics (8N1)
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x04, // SIO_SET_DATA
          value: 0x0008, // 8 data bits, no parity, 1 stop bit
          index: 0x00,
        });

        // Step 4: Set baudrate
        const baseClock = 3000000; // 48MHz / 16
        let divisor = baseClock / baudRate;
        const integerPart = Math.floor(divisor);
        const fractionalPart = divisor - integerPart;

        let subInteger;
        if (fractionalPart < 0.0625) subInteger = 0;
        else if (fractionalPart < 0.1875) subInteger = 1;
        else if (fractionalPart < 0.3125) subInteger = 2;
        else if (fractionalPart < 0.4375) subInteger = 3;
        else if (fractionalPart < 0.5625) subInteger = 4;
        else if (fractionalPart < 0.6875) subInteger = 5;
        else if (fractionalPart < 0.8125) subInteger = 6;
        else subInteger = 7;

        const value =
          (integerPart & 0xff) |
          ((subInteger & 0x07) << 14) |
          (((integerPart >> 8) & 0x3f) << 8);
        const index = (integerPart >> 14) & 0x03;

        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x03, // SIO_SET_BAUD_RATE
          value: value,
          index: index,
        });

        // Step 5: Set DTR/RTS (modem control)
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x01, // SIO_MODEM_CTRL
          value: 0x0303, // DTR=1, RTS=1
          index: 0x00,
        });
      } catch (e) {
        this._log("[WebUSB FTDI] Initialization error:", e.message);
      }
    }
    // Prolific PL2303 initialization (VID: 0x067b)
    else if (this.device.vendorId === 0x067b) {
      try {
        await this._initPL2303(baudRate);
      } catch (e) {
        await this.close();
        throw e;
      }
    }
    // CH340-specific initialization (VID: 0x1a86, non-CDC variants)
    else if (
      this.device.vendorId === 0x1a86 &&
      (this.device.productId === 0x7523 ||
        this.device.productId === 0x5523 ||
        this.device.productId === 0x7522 ||
        this.device.productId === 0x7584)
    ) {
      try {
        // Step 1: Initialize CH340
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0xa1, // CH340 INIT
          value: 0x0000,
          index: 0x0000,
        });

        // Step 2: Set baudrate
        const CH341_BAUDBASE_FACTOR = 1532620800;
        const CH341_BAUDBASE_DIVMAX = 3;

        let factor = Math.floor(CH341_BAUDBASE_FACTOR / baudRate);
        let divisor = CH341_BAUDBASE_DIVMAX;

        while (factor > 0xfff0 && divisor > 0) {
          factor >>= 3;
          divisor--;
        }

        if (factor > 0xfff0) {
          throw new Error(`Baudrate ${baudRate} not supported by CH340`);
        }

        factor = 0x10000 - factor;
        const a = (factor & 0xff00) | divisor;
        const b = factor & 0xff;

        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x9a,
          value: 0x1312,
          index: a,
        });

        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x9a,
          value: 0x0f2c,
          index: b,
        });

        // Step 3: Set handshake (DTR/RTS)
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0xa4, // CH340 SET_HANDSHAKE
          value: ~((1 << 5) | (1 << 6)) & 0xffff, // DTR=1, RTS=1 (inverted), masked to 16-bit
          index: 0x0000,
        });
      } catch (e) {
        this._log("[WebUSB CH340] Initialization error:", e.message);
      }
    }
    // WCH CDC variants (CH342, CH343, CH344, CH9101, CH9102, CH9103, CH9104, etc.)
    else if (this.device.vendorId === 0x1a86) {
      await this._initCH343(baudRate);
    } else {
      // Standard CDC/ACM initialization for other chips
      try {
        const lineCoding = new Uint8Array([
          baudRate & 0xff,
          (baudRate >> 8) & 0xff,
          (baudRate >> 16) & 0xff,
          (baudRate >> 24) & 0xff,
          0x00, // 1 stop bit
          0x00, // No parity
          0x08, // 8 data bits
        ]);

        await this.device.controlTransferOut(
          {
            requestType: "class",
            recipient: "interface",
            request: 0x20, // SET_LINE_CODING
            value: 0,
            index: this.controlInterface || 0,
          },
          lineCoding,
        );
      } catch (e) {
        this._log("Could not set line coding:", e.message);
      }

      try {
        await this.device.controlTransferOut({
          requestType: "class",
          recipient: "interface",
          request: 0x22, // SET_CONTROL_LINE_STATE
          value: 0x03, // DTR=1, RTS=1 (both asserted)
          index: this.controlInterface || 0,
        });
      } catch (e) {
        this._log("Could not set control lines:", e.message);
      }
    }

    // Create streams only if they don't exist yet
    if (!this.readableStream || !this.writableStream) {
      this._createStreams();
    } else {
      // Streams exist, but make sure read loop is running
      if (!this._readLoopRunning) {
        this._readLoopRunning = true;
        // Note: ReadableStream can't be restarted, we need to recreate it
        this._createStreams();
      }
    }

    // Setup disconnect handler only once
    if (!this._usbDisconnectHandler) {
      this._usbDisconnectHandler = (event) => {
        if (event.device === this.device) {
          this._fireEvent("disconnect");
          this._cleanup();
        }
      };
      navigator.usb.addEventListener("disconnect", this._usbDisconnectHandler);
    }
  }

  /**
   * Close the device (mimics port.close())
   */
  async close() {
    this._cleanup();
    if (this.device) {
      try {
        if (this.interfaceNumber !== null) {
          await this.device.releaseInterface(this.interfaceNumber);
        }
        if (
          this.controlInterface !== null &&
          this.controlInterface !== this.interfaceNumber
        ) {
          await this.device.releaseInterface(this.controlInterface);
        }
        await this.device.close();
      } catch (e) {
        if (!e.message || !e.message.includes("disconnected")) {
          this._log("Error closing device:", e.message || e);
        }
      }
      this.interfaceNumber = null;
      this.controlInterface = null;
      this.endpointIn = null;
      this.endpointOut = null;
      // Keep device reference for potential reconfiguration
    }
  }

  /**
   * Disconnect and clear device reference (for final cleanup)
   */
  async disconnect() {
    await this.close();
    this.device = null;
  }

  /**
   * Get optimal block size for flash read operations
   * (maxTransferSize - 2) / 2
   * This accounts for SLIP overhead and escape sequences
   * @returns {number} Optimal block size in bytes
   */
  getOptimalReadBlockSize() {
    // Formula for WebUSB:
    // blockSize = (maxTransferSize - 2) / 2
    // -2 for SLIP frame delimiters (0xC0 at start/end)
    // /2 because worst case every byte could be escaped (0xDB 0xDC or 0xDB 0xDD)
    return Math.floor((this.maxTransferSize - 2) / 2);
  }

  /**
   * Get device info (mimics port.getInfo())
   */
  getInfo() {
    if (!this.device) {
      return {};
    }
    return {
      usbVendorId: this.device.vendorId,
      usbProductId: this.device.productId,
    };
  }

  /**
   * Set DTR/RTS signals (mimics port.setSignals())
   * CRITICAL: Commands are serialized via queue for CP2102 compatibility
   * Supports both CDC/ACM (CH343) and Vendor-Specific (CP2102, CH340)
   */
  async setSignals(signals) {
    // Serialize all control transfers through a queue
    // This is CRITICAL for CP2102 - parallel commands cause hangs
    this._commandQueue = this._commandQueue
      .then(async () => {
        if (!this.device) {
          throw new Error("Device not open");
        }

        const vid = this.device.vendorId;
        const pid = this.device.productId;

        // Detect chip type and use appropriate control request
        // CP2102 (Silicon Labs VID: 0x10c4)
        if (vid === 0x10c4) {
          return await this._setSignalsCP2102(signals);
        }
        // WCH (CH340, CH341, CH342, CH343, CH344, CH9101, CH9102, etc. VID: 0x1a86)
        // All WCH chips support vendor request 0xA4 to the device endpoint,
        // which bypasses OS CDC control interface restrictions (e.g. on macOS)
        else if (vid === 0x1a86) {
          return await this._setSignalsWCH(signals);
        }
        // FTDI (VID: 0x0403)
        else if (vid === 0x0403) {
          return await this._setSignalsFTDI(signals);
        }
        // Prolific PL2303 (VID: 0x067b)
        else if (vid === 0x067b) {
          return await this._setSignalsPL2303(signals);
        }
        // CDC/ACM (CH343, Native USB, MCP2200, CY7C65213, etc.)
        else {
          return await this._setSignalsCDC(signals);
        }
      })
      .catch((err) => {
        this._log("[WebUSB] setSignals error:", err);
        throw err;
      });

    return this._commandQueue;
  }

  /**
   * Set signals using CDC/ACM standard (for CH343, Native USB)
   */
  async _setSignalsCDC(signals) {
    // Preserve current state for unspecified signals (Web Serial semantics)
    const dtr =
      signals.dataTerminalReady !== undefined
        ? signals.dataTerminalReady
        : this._currentDTR;
    const rts =
      signals.requestToSend !== undefined
        ? signals.requestToSend
        : this._currentRTS;

    // Update tracked state
    this._currentDTR = dtr;
    this._currentRTS = rts;

    let value = 0;
    value |= dtr ? 1 : 0;
    value |= rts ? 2 : 0;

    try {
      const result = await this.device.controlTransferOut({
        requestType: "class",
        recipient: "interface",
        request: 0x22, // SET_CONTROL_LINE_STATE
        value: value,
        index: this.controlInterface || 0,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      return result;
    } catch (e) {
      this._log(`[WebUSB CDC] Failed to set signals: ${e.message}`);
      throw e;
    }
  }

  /**
   * Set signals for CP2102 (Silicon Labs vendor-specific)
   */
  async _setSignalsCP2102(signals) {
    // CP2102 uses vendor-specific request 0x07 (SET_MHS)
    // Bit 0: DTR, Bit 1: RTS, Bit 8-9: DTR/RTS mask

    // Preserve current state for unspecified signals (Web Serial semantics)
    const dtr =
      signals.dataTerminalReady !== undefined
        ? signals.dataTerminalReady
        : this._currentDTR;
    const rts =
      signals.requestToSend !== undefined
        ? signals.requestToSend
        : this._currentRTS;

    // Update tracked state
    this._currentDTR = dtr;
    this._currentRTS = rts;

    // Build value with mask bits for both signals
    let value = 0;
    value |= (dtr ? 1 : 0) | 0x100; // DTR + mask
    value |= (rts ? 2 : 0) | 0x200; // RTS + mask

    try {
      const result = await this.device.controlTransferOut({
        requestType: "vendor",
        recipient: "device",
        request: 0x07, // SET_MHS (Modem Handshaking)
        value: value,
        index: 0x00, // CP2102 always uses index 0
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      return result;
    } catch (e) {
      this._log(`[WebUSB CP2102] Failed to set signals: ${e.message}`);
      throw e;
    }
  }

  /**
   * Set signals for WCH chips (CH340, CH341, CH342, CH343, CH344, CH9101, CH9102, etc.)
   */
  async _setSignalsWCH(signals) {
    // Preserve current state for unspecified signals (Web Serial semantics)
    const dtr =
      signals.dataTerminalReady !== undefined
        ? signals.dataTerminalReady
        : this._currentDTR;
    const rts =
      signals.requestToSend !== undefined
        ? signals.requestToSend
        : this._currentRTS;

    // Update tracked state
    this._currentDTR = dtr;
    this._currentRTS = rts;

    // WCH CMD_C2 (0xA4) control request on device endpoint 0:
    // Bit 5 (0x20): DTR, Bit 6 (0x40): RTS (inverted logic)
    // Masked to unsigned 16-bit
    const value = ~((dtr ? 1 << 5 : 0) | (rts ? 1 << 6 : 0)) & 0xffff;

    let result;
    let success = false;
    let lastError = null;

    try {
      result = await this.device.controlTransferOut({
        requestType: "vendor",
        recipient: "device",
        request: 0xa4, // WCH CMD_C2 control request
        value: value,
        index: 0,
      });
      success = true;
    } catch (e) {
      lastError = e;
      this._log(`[WebUSB WCH] Vendor controlTransferOut failed: ${e.message}`);
    }

    // Also send standard CDC SET_CONTROL_LINE_STATE (0x22)
    const cdcValue = (dtr ? 1 : 0) | (rts ? 2 : 0);
    let cdcSent = false;
    if (this.controlInterface !== null) {
      try {
        const cdcResult = await this.device.controlTransferOut({
          requestType: "class",
          recipient: "interface",
          request: 0x22,
          value: cdcValue,
          index: this.controlInterface,
        });
        result = cdcResult || result;
        cdcSent = true;
        success = true;
      } catch (e) {
        lastError = e;
      }
    }
    if (!cdcSent) {
      try {
        const cdcResult = await this.device.controlTransferOut({
          requestType: "class",
          recipient: "device",
          request: 0x22,
          value: cdcValue,
          index: 0,
        });
        result = cdcResult || result;
        success = true;
      } catch (e) {
        lastError = e;
      }
    }

    if (!success) {
      const err = lastError || new Error("Failed to set WCH signals");
      this._log(`[WebUSB WCH] Failed to set signals: ${err.message}`);
      throw err;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    return result;
  }

  /**
   * Calculate baudrate divisor and parameters for WCH CH343/CH9102/CH342/CH344
   * Reference: Official Linux ch343.c driver (Nanjing Qinheng Microelectronics)
   */
  _calcCH343Baud(baudRate) {
    let b, c;
    switch (baudRate) {
      case 6000000:
      case 4000000:
      case 2400000:
      case 921600:
      case 307200:
      case 256000:
        b = 7;
        c = 12000000;
        break;
      default:
        if (baudRate > 6000000 / 255) {
          b = 3;
          c = 6000000;
        } else if (baudRate > 750000 / 255) {
          b = 2;
          c = 750000;
        } else if (baudRate > 93750 / 255) {
          b = 1;
          c = 93750;
        } else {
          b = 0;
          c = 11719;
        }
        break;
    }
    let a = Math.floor(c / baudRate);
    if (a === 0 || a >= 255) a = 1;
    if (c / a - baudRate > baudRate - c / (a + 1)) {
      a++;
    }
    a = (256 - a) & 0xff;
    const fct = a;
    const dvs = b;

    // 8 data bits (CH343_L_C8 = 0x03), RX enable (0x80), TX enable (0x40)
    const reg_value = 0xc3;
    // CH343_L_R_CT (0x80) | CH343_L_R_CL (0x04) | CH343_L_R_T (0x08)
    const reg_count = 0x8c;
    const value = (reg_count | (reg_value << 8)) & 0xffff;
    const index = (dvs | (fct << 8)) & 0xffff;
    return { value, index };
  }

  /**
   * Set baudrate for WCH CH343/CH9102/CH342/CH344 chips
   */
  async _setBaudRateCH343(baudRate) {
    // 1. Vendor baud rate command CMD_C1 (0xA1) to device endpoint 0
    try {
      const { value, index } = this._calcCH343Baud(baudRate);
      await this.device.controlTransferOut({
        requestType: "vendor",
        recipient: "device",
        request: 0xa1, // CMD_C1
        value: value,
        index: index,
      });
    } catch (e) {
      this._log("[WebUSB CH343] Vendor baudrate error:", e.message);
    }

    // 2. Also send standard CDC SET_LINE_CODING (0x20)
    try {
      const lineCoding = new Uint8Array([
        baudRate & 0xff,
        (baudRate >> 8) & 0xff,
        (baudRate >> 16) & 0xff,
        (baudRate >> 24) & 0xff,
        0x00, // 1 stop bit
        0x00, // No parity
        0x08, // 8 data bits
      ]);

      await this.device.controlTransferOut(
        {
          requestType: "class",
          recipient: "interface",
          request: 0x20, // SET_LINE_CODING
          value: 0,
          index: this.controlInterface !== null ? this.controlInterface : 0,
        },
        lineCoding,
      );
    } catch (_e) {}
  }

  /**
   * Initialize WCH CH343/CH9102/CH342/CH344 chips
   */
  async _initCH343(baudRate) {
    try {
      // Step 1: Configuration inquiry CMD_C6 (0x5F)
      try {
        await this.device.controlTransferIn(
          {
            requestType: "vendor",
            recipient: "device",
            request: 0x5f, // CMD_C6
            value: 0,
            index: 0,
          },
          8,
        );
      } catch (_e) {}

      // Step 2: Set baud rate via CMD_C1 (0xA1) & CDC 0x20
      await this._setBaudRateCH343(baudRate);

      // Step 3: Set initial DTR/RTS (both asserted/idle)
      await this._setSignalsWCH({
        dataTerminalReady: true,
        requestToSend: true,
      });
    } catch (e) {
      this._log("[WebUSB CH343] Initialization error:", e.message);
    }
  }

  /**
   * Legacy alias for CH340 signal setting
   */
  async _setSignalsCH340(signals) {
    return await this._setSignalsWCH(signals);
  }

  /**
   * Set signals for FTDI (FT232, FT2232, etc.)
   */
  async _setSignalsFTDI(signals) {
    // Preserve current state for unspecified signals (Web Serial semantics)
    const dtr =
      signals.dataTerminalReady !== undefined
        ? signals.dataTerminalReady
        : this._currentDTR;
    const rts =
      signals.requestToSend !== undefined
        ? signals.requestToSend
        : this._currentRTS;

    // Update tracked state
    this._currentDTR = dtr;
    this._currentRTS = rts;

    // FTDI SIO_MODEM_CTRL (request 0x01)
    // Bit 0: DTR, Bit 1: RTS
    // Bit 8: DTR mask (0x0100), Bit 9: RTS mask (0x0200)
    let value = 0;
    value |= dtr ? 1 : 0;
    value |= rts ? 2 : 0;
    value |= 0x0100 | 0x0200; // Enable change of both DTR and RTS

    try {
      const result = await this.device.controlTransferOut({
        requestType: "vendor",
        recipient: "device",
        request: 0x01, // SIO_MODEM_CTRL
        value: value,
        index: 0x00,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      return result;
    } catch (e) {
      this._log(`[WebUSB FTDI] Failed to set signals: ${e.message}`);
      throw e;
    }
  }

  /**
   * Set signals for Prolific PL2303
   */
  async _setSignalsPL2303(signals) {
    // Preserve current state for unspecified signals (Web Serial semantics)
    const dtr =
      signals.dataTerminalReady !== undefined
        ? signals.dataTerminalReady
        : this._currentDTR;
    const rts =
      signals.requestToSend !== undefined
        ? signals.requestToSend
        : this._currentRTS;

    // Update tracked state
    this._currentDTR = dtr;
    this._currentRTS = rts;

    let value = 0;
    value |= dtr ? 1 : 0; // CONTROL_DTR
    value |= rts ? 2 : 0; // CONTROL_RTS

    try {
      const result = await this.device.controlTransferOut({
        requestType: "class",
        recipient: "interface",
        request: 0x22, // SET_CONTROL_LINE_STATE
        value: value,
        index: this.controlInterface || 0,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      return result;
    } catch (e) {
      this._log(`[WebUSB PL2303] Failed to set signals: ${e.message}`);
      throw e;
    }
  }

  /**
   * Set line coding (baudrate) for Prolific PL2303
   */
  async _setLineCodingPL2303(baudRate) {
    const lineCoding = new Uint8Array([
      baudRate & 0xff,
      (baudRate >> 8) & 0xff,
      (baudRate >> 16) & 0xff,
      (baudRate >> 24) & 0xff,
      0x00, // 1 stop bit
      0x00, // No parity
      0x08, // 8 data bits
    ]);

    await this.device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request: 0x20, // SET_LINE_CODING
        value: 0,
        index: this.controlInterface || 0,
      },
      lineCoding,
    );
  }

  /**
   * Initialize Prolific PL2303 chip
   */
  async _initPL2303(baudRate) {
    // Vendor startup sequence (for PL2303HX/HXD/TA/etc.)
    // Safe: ignore errors on newer revisions (e.g. PL2303G / GC)
    const vendorRead = async (value) => {
      try {
        await this.device.controlTransferIn(
          {
            requestType: "vendor",
            recipient: "device",
            request: 0x01,
            value: value,
            index: 0,
          },
          1,
        );
      } catch (_e) {
        // Ignore
      }
    };

    const vendorWrite = async (value, index) => {
      try {
        await this.device.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0x01,
          value: value,
          index: index,
        });
      } catch (_e) {
        // Ignore
      }
    };

    await vendorRead(0x8484);
    await vendorWrite(0x0404, 0);
    await vendorRead(0x8484);
    await vendorRead(0x8383);
    await vendorRead(0x8484);
    await vendorWrite(0x0404, 1);
    await vendorRead(0x8484);
    await vendorRead(0x8383);
    await vendorWrite(0, 1);
    await vendorWrite(1, 0);
    await vendorWrite(2, 0x44);

    try {
      // Set baud rate and line coding
      await this._setLineCodingPL2303(baudRate);

      // Initial modem control signals (DTR=1, RTS=1)
      await this._setSignalsPL2303({
        dataTerminalReady: true,
        requestToSend: true,
      });
    } catch (e) {
      this._log("[WebUSB PL2303] Initialization error:", e.message);
      throw e;
    }
  }

  /**
   * Change baudrate after port is already open
   * This is needed for ESP stub loader which changes baudrate after uploading stub
   * NOTE: Only needed for vendor-specific chips (CP2102, CH340, FTDI)
   * CDC devices (CH343, ESP32-S2/S3/C3 Native USB) handle baudrate automatically
   */
  async setBaudRate(baudRate) {
    if (!this.device) {
      throw new Error("Device not open");
    }

    const vid = this.device.vendorId;
    const pid = this.device.productId;

    //        this._log(`[WebUSB] Changing baudrate to ${baudRate}...`);

    // FTDI (VID: 0x0403)
    if (vid === 0x0403) {
      // FTDI baudrate calculation
      // Modern FTDI chips (FT232R, FT2232, etc.): BaseClock = 48MHz
      // BaudDivisor = (48000000 / 16) / BaudRate = 3000000 / BaudRate
      // Divisor encoding: 16-bit value with sub-integer divisor support
      // Sub-integer divisor: 0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875

      const baseClock = 3000000; // 48MHz / 16
      let divisor = baseClock / baudRate;

      // Extract integer and fractional parts
      const integerPart = Math.floor(divisor);
      const fractionalPart = divisor - integerPart;

      // Encode sub-integer divisor (0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875)
      let subInteger;
      if (fractionalPart < 0.0625)
        subInteger = 0; // 0.0
      else if (fractionalPart < 0.1875)
        subInteger = 1; // 0.125
      else if (fractionalPart < 0.3125)
        subInteger = 2; // 0.25
      else if (fractionalPart < 0.4375)
        subInteger = 3; // 0.375
      else if (fractionalPart < 0.5625)
        subInteger = 4; // 0.5
      else if (fractionalPart < 0.6875)
        subInteger = 5; // 0.625
      else if (fractionalPart < 0.8125)
        subInteger = 6; // 0.75
      else subInteger = 7; // 0.875

      // Encode divisor value for FTDI
      // Low byte: integer part (bits 0-7)
      // High byte: (integer part >> 8) | (sub-integer << 6)
      const value =
        (integerPart & 0xff) |
        ((subInteger & 0x07) << 14) |
        (((integerPart >> 8) & 0x3f) << 8);
      const index = (integerPart >> 14) & 0x03; // Upper 2 bits of integer part

      //            this._log(`[WebUSB FTDI] Setting baudrate ${baudRate} (divisor=${divisor.toFixed(3)}, value=0x${value.toString(16)}, index=0x${index.toString(16)})...`);

      await this.device.controlTransferOut({
        requestType: "vendor",
        recipient: "device",
        request: 0x03, // SIO_SET_BAUD_RATE
        value: value,
        index: index,
      });

      //            this._log('[WebUSB FTDI] Baudrate changed successfully');
    }
    // CP2102 (Silicon Labs VID: 0x10c4)
    else if (vid === 0x10c4) {
      // CP210x baudrate encoding (from Silicon Labs AN571)
      // For CP2102/CP2103: Use direct 32-bit baudrate value
      // Request: IFC_SET_BAUDRATE (0x1E)

      // Encode baudrate as 32-bit little-endian value
      const baudrateBuffer = new ArrayBuffer(4);
      const baudrateView = new DataView(baudrateBuffer);
      baudrateView.setUint32(0, baudRate, true); // little-endian

      await this.device.controlTransferOut(
        {
          requestType: "vendor",
          recipient: "interface",
          request: 0x1e, // IFC_SET_BAUDRATE
          value: 0,
          index: 0,
        },
        baudrateBuffer,
      );
    }
    // CH340 (WCH VID: 0x1a86, non-CDC variants)
    else if (
      vid === 0x1a86 &&
      (pid === 0x7523 || pid === 0x5523 || pid === 0x7522 || pid === 0x7584)
    ) {
      // CH340 baudrate calculation (from Linux kernel driver)
      const CH341_BAUDBASE_FACTOR = 1532620800;
      const CH341_BAUDBASE_DIVMAX = 3;

      let factor = Math.floor(CH341_BAUDBASE_FACTOR / baudRate);
      let divisor = CH341_BAUDBASE_DIVMAX;

      // Reduce factor if too large
      while (factor > 0xfff0 && divisor > 0) {
        factor >>= 3;
        divisor--;
      }

      if (factor > 0xfff0) {
        throw new Error(`Baudrate ${baudRate} not supported by CH340`);
      }

      factor = 0x10000 - factor;
      const a = (factor & 0xff00) | divisor;
      const b = factor & 0xff;

      // CH340 uses request 0x9A to set baudrate
      await this.device.controlTransferOut({
        requestType: "vendor",
        recipient: "device",
        request: 0x9a, // CH340 SET_BAUDRATE
        value: 0x1312, // Fixed value for baudrate setting
        index: a,
      });

      // Second control transfer with b value
      await this.device.controlTransferOut({
        requestType: "vendor",
        recipient: "device",
        request: 0x9a,
        value: 0x0f2c, // Fixed value
        index: b,
      });
    }
    // WCH CDC variants (CH342, CH343, CH344, CH9101, CH9102, CH9103, etc.)
    else if (vid === 0x1a86) {
      await this._setBaudRateCH343(baudRate);
    }
    // Prolific PL2303 (VID: 0x067b)
    else if (vid === 0x067b) {
      await this._setLineCodingPL2303(baudRate);
    }
    // CDC devices (CH343, CH9102, CH9101, ESP32 Native USB, MCP2200, CY7C65213, etc.)
    else {
      try {
        const lineCoding = new Uint8Array([
          baudRate & 0xff,
          (baudRate >> 8) & 0xff,
          (baudRate >> 16) & 0xff,
          (baudRate >> 24) & 0xff,
          0x00, // 1 stop bit
          0x00, // No parity
          0x08, // 8 data bits
        ]);

        await this.device.controlTransferOut(
          {
            requestType: "class",
            recipient: "interface",
            request: 0x20, // SET_LINE_CODING
            value: 0,
            index: this.controlInterface || 0,
          },
          lineCoding,
        );
      } catch (e) {
        this._log(`[WebUSB CDC] Could not set line coding: ${e.message}`);
        throw e;
      }
    }

    // Wait for baudrate change to take effect
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  get readable() {
    return this.readableStream;
  }

  get writable() {
    return this.writableStream;
  }

  _createStreams() {
    // ReadableStream for incoming data
    this.readableStream = new ReadableStream({
      start: async (controller) => {
        this._readLoopRunning = true;
        let streamErrored = false;

        // Validate endpoints before starting read loop
        if (this.endpointIn == null) {
          controller.error(new Error("Bulk IN endpoint not configured"));
          return;
        }

        try {
          while (this._readLoopRunning && this.device) {
            try {
              // CRITICAL: Check backpressure before reading more data
              // If desiredSize is 0 or negative, the consumer can't keep up
              // Wait for the consumer to drain the buffer before reading more
              if (
                controller.desiredSize !== null &&
                controller.desiredSize <= 0
              ) {
                // Consumer is backlogged - wait before reading more
                await new Promise((r) => setTimeout(r, 10));
                continue;
              }

              const result = await this.device.transferIn(
                this.endpointIn,
                this.maxTransferSize,
              );

              if (result.status === "ok") {
                controller.enqueue(
                  new Uint8Array(
                    result.data.buffer,
                    result.data.byteOffset,
                    result.data.byteLength,
                  ),
                );
                // Small delay to allow consumer to process data
                // This prevents overwhelming the TextDecoderStream on Android
                await new Promise((r) => setTimeout(r, 1));
                continue;
              } else if (result.status === "stall") {
                await this.device.clearHalt("in", this.endpointIn);
                await new Promise((r) => setTimeout(r, 1));
                continue;
              }
              // Only wait if no data was received
              await new Promise((r) => setTimeout(r, 1));
            } catch (error) {
              if (
                error.message &&
                (error.message.includes("device unavailable") ||
                  error.message.includes("device has been lost") ||
                  error.message.includes("device was disconnected") ||
                  error.message.includes("No device selected"))
              ) {
                break;
              }
              if (
                error.message &&
                (error.message.includes("transfer was cancelled") ||
                  error.message.includes("transfer error has occurred"))
              ) {
                continue;
              }
              this._log("USB read error:", error.message);
              // Wait a bit after error before retrying
              await new Promise((r) => setTimeout(r, 10));
            }
          }
        } catch (error) {
          streamErrored = true;
          controller.error(error);
        } finally {
          // Only close if stream didn't error
          if (!streamErrored) {
            controller.close();
          }
        }
      },
      cancel: () => {
        this._readLoopRunning = false;
      },
    });

    // WritableStream for outgoing data
    this.writableStream = new WritableStream({
      write: async (chunk) => {
        if (!this.device) {
          throw new Error("Device not open");
        }
        if (this.endpointOut == null) {
          throw new Error("Bulk OUT endpoint not configured");
        }
        await this.device.transferOut(this.endpointOut, chunk);
      },
    });
  }

  /**
   * Recreate streams without closing the port
   * Useful after hardware reset or when switching to console mode
   * This stops the current read loop and creates fresh streams
   */
  recreateStreams() {
    // Stop the current read loop
    this._readLoopRunning = false;

    // Wait a bit for the read loop to finish
    // The ReadableStream will close itself when _readLoopRunning becomes false
    return new Promise((resolve) => {
      setTimeout(() => {
        // Create new streams
        this._createStreams();
        resolve();
      }, 100);
    });
  }

  _cleanup() {
    this._readLoopRunning = false;
    if (this._usbDisconnectHandler) {
      navigator.usb.removeEventListener(
        "disconnect",
        this._usbDisconnectHandler,
      );
      this._usbDisconnectHandler = null;
    }
  }

  _fireEvent(type) {
    const listeners = this._eventListeners[type] || [];
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (e) {
        this._log(`Error in ${type} event listener:`, e);
      }
    });
  }

  addEventListener(type, listener) {
    if (this._eventListeners[type]) {
      this._eventListeners[type].push(listener);
    }
  }

  removeEventListener(type, listener) {
    if (this._eventListeners[type]) {
      const index = this._eventListeners[type].indexOf(listener);
      if (index !== -1) {
        this._eventListeners[type].splice(index, 1);
      }
    }
  }
}

/**
 * Unified port request function that tries WebUSB first on Android, Web Serial on Desktop
 * This provides seamless support for both desktop (Web Serial) and Android (WebUSB)
 * @param {boolean} forceNew - If true, forces selection of a new device (ignores already paired devices)
 * @param {string} transportMode - Transport mode: 'auto', 'webserial', or 'webusb'
 * @param {function} logger - Logger function for messages
 */
async function requestSerialPort(
  forceNew = false,
  transportMode = "auto",
  logger = null,
) {
  // Detect if we're on Android
  const isAndroid = /Android/i.test(navigator.userAgent);
  const hasSerial = "serial" in navigator;
  const hasUSB = "usb" in navigator;

  const log = (msg) => {
    if (logger) {
      logger(msg);
    } else {
      console.log(msg);
    }
  };

  console.log(
    `[requestSerialPort] Platform: ${isAndroid ? "Android" : "Desktop"}, Web Serial: ${hasSerial}, WebUSB: ${hasUSB}, Transport: ${transportMode}`,
  );

  // Determine transport mode based on platform and user selection
  let useWebUSB = false;

  if (transportMode === "webusb") {
    // Explicit WebUSB selection
    useWebUSB = true;
  } else if (transportMode === "webserial") {
    // Explicit Web Serial selection
    useWebUSB = false;
  } else {
    // Auto mode: Android prefers WebUSB, Desktop prefers Web Serial
    // Fall back to the other API when the preferred one is unavailable
    useWebUSB = isAndroid ? hasUSB || !hasSerial : !hasSerial && hasUSB;
  }

  if (useWebUSB) {
    // Use WebUSB
    if (!hasUSB) {
      throw new Error("WebUSB not available in this browser");
    }
    try {
      return await WebUSBSerial.requestPort(logger, forceNew, isAndroid);
    } catch (err) {
      // Rethrow chooser cancellation errors instead of switching transports
      if (err && (err.name === "NotFoundError" || err.name === "AbortError")) {
        throw err;
      }
      // In auto mode, fallback to Web Serial if WebUSB fails
      if (transportMode === "auto" && hasSerial) {
        log("WebUSB failed, falling back to Web Serial...");
        return await navigator.serial.requestPort({
          filters: serialPortFilters,
        });
      }
      throw err;
    }
  } else {
    // Use Web Serial
    if (!hasSerial) {
      throw new Error("Web Serial not available in this browser");
    }
    try {
      return await navigator.serial.requestPort({ filters: serialPortFilters });
    } catch (err) {
      // Rethrow chooser cancellation errors instead of switching transports
      if (err && (err.name === "NotFoundError" || err.name === "AbortError")) {
        throw err;
      }
      // In auto mode, fallback to WebUSB if Web Serial fails
      if (transportMode === "auto" && hasUSB) {
        log("Web Serial failed, falling back to WebUSB...");
        return await WebUSBSerial.requestPort(logger, forceNew, isAndroid);
      }
      throw err;
    }
  }
}

// Also set on globalThis for non-module usage (e.g., dynamic script loading)
if (typeof globalThis !== "undefined") {
  globalThis.WebUSBSerial = WebUSBSerial;
  globalThis.requestSerialPort = requestSerialPort;
}

// Export as ES modules
export { WebUSBSerial, requestSerialPort, serialPortFilters };
