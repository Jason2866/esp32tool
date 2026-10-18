/**
 * Node.js USB Adapter
 *
 * Uses node-usb to directly control USB-Serial chips (CP2102, CH340, FTDI, etc.)
 * This provides the same level of control as WebUSB and avoids node-serialport issues
 */

import { Logger } from "./const";
import type { Device, InEndpoint, OutEndpoint } from "usb";
import { knownVendorIds } from "./util/usb-chips.js";

export interface NodeUSBPort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  isWebUSB?: boolean; // Flag to indicate this behaves like WebUSB

  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;

  setSignals(signals: {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
    break?: boolean;
  }): Promise<void>;

  setBaudRate(baudRate: number): Promise<void>; // Add baudrate change support

  getSignals(): Promise<{
    dataCarrierDetect: boolean;
    clearToSend: boolean;
    ringIndicator: boolean;
    dataSetReady: boolean;
  }>;

  getInfo(): {
    usbVendorId?: number;
    usbProductId?: number;
  };
}

/**
 * Create a Web Serial API compatible port from node-usb Device
 */
export function createNodeUSBAdapter(
  device: Device,
  logger: Logger,
): NodeUSBPort {
  let readableStream: ReadableStream<Uint8Array> | null = null;
  let writableStream: WritableStream<Uint8Array> | null = null;
  let interfaceNumber: number | null = null;
  let controlInterface: number | null = null;
  let endpointIn: InEndpoint | null = null;
  let endpointOut: OutEndpoint | null = null;
  let endpointInNumber: number | null = null;
  let endpointOutNumber: number | null = null;
  // readLoopRunning tracked internally by stream

  // Track current signal states
  let currentDTR: boolean = false;
  let currentRTS: boolean = false;

  const vendorId = device.deviceDescriptor.idVendor;
  const productId = device.deviceDescriptor.idProduct;

  const adapter: NodeUSBPort = {
    isWebUSB: true, // Mark this as WebUSB-like behavior for reset strategy selection

    get readable() {
      return readableStream;
    },

    get writable() {
      return writableStream;
    },

    async open(options: { baudRate: number }) {
      const baudRate = options.baudRate;
      logger.log(`Opening USB device at ${baudRate} baud...`);

      // Open device
      try {
        device.open();
      } catch (err: any) {
        throw new Error(`Failed to open USB device: ${err.message}`);
      }
      // Select configuration
      try {
        if (device.configDescriptor?.bConfigurationValue !== 1) {
          device.setConfiguration(1);
        }
      } catch (_err) {
        // Already configured
      }

      // Find bulk IN/OUT interface
      const config = device.configDescriptor;
      if (!config) {
        throw new Error("No configuration descriptor");
      }

      // Find suitable interface with bulk endpoints
      for (const iface of config.interfaces) {
        for (const alt of iface) {
          let hasIn = false;
          let hasOut = false;
          let inEpNum: number | null = null;
          let outEpNum: number | null = null;

          for (const ep of alt.endpoints) {
            const epDesc = ep as any;
            if (epDesc.bmAttributes === 2 || epDesc.transferType === 2) {
              // Bulk transfer
              const dir = epDesc.bEndpointAddress & 0x80 ? "in" : "out";
              if (dir === "in" && !hasIn) {
                hasIn = true;
                inEpNum = epDesc.bEndpointAddress;
              } else if (dir === "out" && !hasOut) {
                hasOut = true;
                outEpNum = epDesc.bEndpointAddress;
              }
            }
          }

          if (hasIn && hasOut) {
            interfaceNumber = iface[0].bInterfaceNumber;
            endpointInNumber = inEpNum;
            endpointOutNumber = outEpNum;
            logger.debug(
              `Found interface ${interfaceNumber} with IN=0x${inEpNum?.toString(16)}, OUT=0x${outEpNum?.toString(16)}`,
            );
            break;
          }
        }
        if (interfaceNumber !== null) break;
      }

      if (interfaceNumber === null || !endpointInNumber || !endpointOutNumber) {
        throw new Error("No suitable USB interface found");
      }

      // Claim interface
      const usbInterface = device.interface(interfaceNumber);

      // Detach kernel driver if active (Linux/macOS)
      try {
        if (usbInterface.isKernelDriverActive()) {
          usbInterface.detachKernelDriver();
        }
      } catch (_err) {
        // Ignore - may not be supported on all platforms
      }

      usbInterface.claim();

      controlInterface = interfaceNumber;

      // Get the actual endpoints from the claimed interface
      const endpoints = usbInterface.endpoints;
      logger.debug(
        `Found ${endpoints.length} endpoints on interface ${interfaceNumber}`,
      );

      // Find endpoints by address
      endpointIn = endpoints.find(
        (ep: any) => ep.address === endpointInNumber,
      ) as InEndpoint;
      endpointOut = endpoints.find(
        (ep: any) => ep.address === endpointOutNumber,
      ) as OutEndpoint;

      if (!endpointIn || !endpointOut) {
        throw new Error(
          `Could not find endpoints: IN=0x${endpointInNumber?.toString(16)}, OUT=0x${endpointOutNumber?.toString(16)}`,
        );
      }

      logger.debug(
        `Endpoints ready: IN=0x${endpointIn.address.toString(16)}, OUT=0x${endpointOut.address.toString(16)}`,
      );

      // Initialize chip-specific settings
      try {
        await initializeChip(device, vendorId, productId, baudRate, logger);
      } catch (err: any) {
        logger.error(`Failed to initialize chip: ${err.message}`);
        throw err;
      }

      // For CP2102: Clear any pending data
      if (vendorId === 0x10c4) {
        try {
          // Clear halt on endpoints
          await new Promise<void>((resolve, _reject) => {
            device.controlTransfer(
              0x02, // Clear Feature, Endpoint
              0x01, // ENDPOINT_HALT
              0,
              endpointIn!.address,
              Buffer.alloc(0),
              (err) => {
                if (err) logger.debug(`Clear halt IN failed: ${err.message}`);
                resolve();
              },
            );
          });

          await new Promise<void>((resolve, _reject) => {
            device.controlTransfer(
              0x02, // Clear Feature, Endpoint
              0x01, // ENDPOINT_HALT
              0,
              endpointOut!.address,
              Buffer.alloc(0),
              (err) => {
                if (err) logger.debug(`Clear halt OUT failed: ${err.message}`);
                resolve();
              },
            );
          });
        } catch (_err) {
          // Ignore
        }
      }

      // Wait for chip to be ready
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create streams
      createStreams();
    },

    async close() {
      // Stop polling and remove event listeners BEFORE cancelling streams
      if (endpointIn) {
        try {
          endpointIn.stopPoll();
          endpointIn.removeAllListeners();
        } catch (_err) {
          // Ignore
        }
      }

      if (readableStream) {
        try {
          await readableStream.cancel();
        } catch (_err) {
          // Ignore
        }
        readableStream = null;
      }

      if (writableStream) {
        try {
          await writableStream.close();
        } catch (_err) {
          // Ignore
        }
        writableStream = null;
      }

      // Small delay to let any pending callbacks complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (interfaceNumber !== null) {
        try {
          const usbInterface = device.interface(interfaceNumber);
          usbInterface.release(true, () => {});
        } catch (_err) {
          // Ignore
        }
      }

      try {
        device.close();
      } catch (_err) {
        // Ignore
      }
    },

    async setSignals(signals: {
      dataTerminalReady?: boolean;
      requestToSend?: boolean;
      break?: boolean;
    }) {
      // Preserve current state for unspecified signals
      const dtr =
        signals.dataTerminalReady !== undefined
          ? signals.dataTerminalReady
          : currentDTR;
      const rts =
        signals.requestToSend !== undefined
          ? signals.requestToSend
          : currentRTS;

      currentDTR = dtr;
      currentRTS = rts;

      //      logger.log(`Setting signals: DTR=${dtr}, RTS=${rts} (CP2102: GPIO0=${dtr ? 'LOW' : 'HIGH'}, EN=${rts ? 'LOW' : 'HIGH'})`);

      // CP2102 (Silicon Labs VID: 0x10c4)
      if (vendorId === 0x10c4) {
        await setSignalsCP2102(device, dtr, rts);
      }
      // WCH (CH340, CH341, CH342, CH343, CH344, CH9101, CH9102, etc. VID: 0x1a86)
      else if (vendorId === 0x1a86) {
        await setSignalsCH340(device, dtr, rts);
      }
      // FTDI (VID: 0x0403)
      else if (vendorId === 0x0403) {
        await setSignalsFTDI(device, dtr, rts);
      }
      // CDC/ACM (CH343, Native USB, PL2303, etc.)
      else {
        await setSignalsCDC(device, dtr, rts, controlInterface || 0);
      }

      // Match WebUSB timing - 50ms delay is critical for bootloader entry
      // This ensures signals are stable before next operation
      await new Promise((resolve) => setTimeout(resolve, 50));
    },

    async setBaudRate(baudRate: number) {
      // CP2102 (Silicon Labs VID: 0x10c4)
      if (vendorId === 0x10c4) {
        //        logger.debug(`[USB] CP2102: Setting baudrate to ${baudRate}...`);
        const baudrateBuffer = Buffer.alloc(4);
        baudrateBuffer.writeUInt32LE(baudRate, 0);
        await controlTransferOut(
          device,
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
        vendorId === 0x1a86 &&
        (productId === 0x7523 ||
          productId === 0x5523 ||
          productId === 0x7522 ||
          productId === 0x7584)
      ) {
        const CH341_BAUDBASE_FACTOR = 1532620800;
        const CH341_BAUDBASE_DIVMAX = 3;

        let factor = Math.floor(CH341_BAUDBASE_FACTOR / baudRate);
        let divisor = CH341_BAUDBASE_DIVMAX;

        while (factor > 0xfff0 && divisor > 0) {
          factor >>= 3;
          divisor--;
        }

        factor = 0x10000 - factor;
        const a = (factor & 0xff00) | divisor;
        const b = factor & 0xff;

        await controlTransferOut(device, {
          requestType: "vendor",
          recipient: "device",
          request: 0x9a,
          value: 0x1312,
          index: a,
        });

        await controlTransferOut(device, {
          requestType: "vendor",
          recipient: "device",
          request: 0x9a,
          value: 0x0f2c,
          index: b,
        });
      }
      // WCH CDC variants (CH342, CH343, CH344, CH9101, CH9102, CH9103, etc.)
      else if (vendorId === 0x1a86) {
        await setBaudRateCH343(device, baudRate, controlInterface || 0);
      }
      // FTDI (VID: 0x0403)
      else if (vendorId === 0x0403) {
        const baseClock = 3000000;
        const divisor = baseClock / baudRate;
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

        await controlTransferOut(device, {
          requestType: "vendor",
          recipient: "device",
          request: 0x03,
          value: value,
          index: index,
        });
      }
      // CDC/ACM (CH343, Native USB, etc.)
      else {
        const lineCoding = Buffer.alloc(7);
        lineCoding.writeUInt32LE(baudRate, 0);
        lineCoding[4] = 0x00; // 1 stop bit
        lineCoding[5] = 0x00; // No parity
        lineCoding[6] = 0x08; // 8 data bits

        await controlTransferOut(
          device,
          {
            requestType: "class",
            recipient: "interface",
            request: 0x20,
            value: 0,
            index: controlInterface || 0,
          },
          lineCoding,
        );
      }
    },

    async getSignals() {
      // Not implemented for USB - return dummy values
      return {
        dataCarrierDetect: false,
        clearToSend: false,
        ringIndicator: false,
        dataSetReady: false,
      };
    },

    getInfo() {
      return {
        usbVendorId: vendorId,
        usbProductId: productId,
      };
    },
  };

  function createStreams() {
    if (!endpointIn || !endpointOut) {
      throw new Error("Endpoints not configured");
    }

    // Start polling immediately (not in ReadableStream.start)
    try {
      endpointIn.startPoll(2, 64);
    } catch (err: any) {
      logger.error(`Failed to start poll: ${err.message}`);
    }

    // ReadableStream for incoming data
    readableStream = new ReadableStream({
      start(controller) {
        endpointIn!.on("data", (data: Buffer) => {
          try {
            if (data.length > 0) {
              controller.enqueue(new Uint8Array(data));
            }
          } catch (err: any) {
            logger.error(`USB RX handler error: ${err.message}`);
          }
        });

        endpointIn!.on("error", (err: Error) => {
          try {
            logger.error(`USB read error: ${err.message}`);
            // Don't close on error, just log it
          } catch (_e) {
            // Ignore errors in error handler
          }
        });

        endpointIn!.on("end", () => {
          try {
            controller.close();
          } catch (_err) {
            // Ignore errors when closing controller
          }
        });
      },

      cancel() {
        if (endpointIn) {
          try {
            endpointIn.stopPoll();
            endpointIn.removeAllListeners();
          } catch (_err) {
            // Ignore
          }
        }
      },
    });

    // WritableStream for outgoing data
    writableStream = new WritableStream({
      async write(chunk: Uint8Array) {
        return new Promise((resolve, reject) => {
          if (!endpointOut) {
            reject(new Error("Endpoint not configured"));
            return;
          }

          endpointOut.transfer(Buffer.from(chunk), (err) => {
            if (err) {
              logger.error(`USB TX error: ${err.message}`);
              reject(err);
            } else {
              resolve();
            }
          });
        });
      },
    });
  }

  return adapter;
}

// Chip-specific initialization functions

async function initializeChip(
  device: Device,
  vendorId: number,
  productId: number,
  baudRate: number,
  logger: Logger,
): Promise<void> {
  // CP2102 (Silicon Labs)
  if (vendorId === 0x10c4) {
    logger.debug("Initializing CP2102...");

    // Step 1: Enable UART
    logger.debug("CP2102: Enabling UART interface...");
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x00, // IFC_ENABLE
      value: 0x01, // UART_ENABLE
      index: 0x00,
    });

    // Step 2: Set line control (8N1)
    logger.debug("CP2102: Setting line control (8N1)...");
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x03, // SET_LINE_CTL
      value: 0x0800, // 8 data bits, no parity, 1 stop bit
      index: 0x00,
    });

    // Step 3: Set DTR/RTS
    logger.debug("CP2102: Setting DTR/RTS...");
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x07, // SET_MHS
      value: 0x03 | 0x0100 | 0x0200, // DTR=1, RTS=1 with masks
      index: 0x00,
    });

    // Step 4: Set baudrate
    logger.debug(`CP2102: Setting baudrate to ${baudRate}...`);
    const baudrateBuffer = Buffer.alloc(4);
    baudrateBuffer.writeUInt32LE(baudRate, 0);
    await controlTransferOut(
      device,
      {
        requestType: "vendor",
        recipient: "interface",
        request: 0x1e, // IFC_SET_BAUDRATE
        value: 0,
        index: 0,
      },
      baudrateBuffer,
    );

    logger.debug("CP2102: Initialization complete");
  }
  // CH340 (WCH non-CDC)
  else if (
    vendorId === 0x1a86 &&
    (productId === 0x7523 ||
      productId === 0x5523 ||
      productId === 0x7522 ||
      productId === 0x7584)
  ) {
    logger.debug("Initializing CH340...");

    // Initialize
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0xa1,
      value: 0x0000,
      index: 0x0000,
    });

    // Set baudrate
    const CH341_BAUDBASE_FACTOR = 1532620800;
    const CH341_BAUDBASE_DIVMAX = 3;

    let factor = Math.floor(CH341_BAUDBASE_FACTOR / baudRate);
    let divisor = CH341_BAUDBASE_DIVMAX;

    while (factor > 0xfff0 && divisor > 0) {
      factor >>= 3;
      divisor--;
    }

    factor = 0x10000 - factor;
    const a = (factor & 0xff00) | divisor;
    const b = factor & 0xff;

    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x9a,
      value: 0x1312,
      index: a,
    });

    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x9a,
      value: 0x0f2c,
      index: b,
    });

    // Set handshake
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0xa4,
      value: ~((1 << 5) | (1 << 6)) & 0xffff,
      index: 0x0000,
    });
  }
  // WCH CDC variants (CH342, CH343, CH344, CH9101, CH9102, CH9103, etc.)
  else if (vendorId === 0x1a86) {
    logger.debug("Initializing CH343/WCH CDC...");
    try {
      await controlTransferIn(
        device,
        {
          requestType: "vendor",
          recipient: "device",
          request: 0x5f, // CMD_C6
          value: 0,
          index: 0,
        },
        8,
      );
    } catch (_e) {
      // Ignore if device does not support CMD_C6
    }

    await setBaudRateCH343(device, baudRate, 0);

    // Initial DTR/RTS
    await setSignalsCH340(device, true, true);
  }
  // FTDI
  else if (vendorId === 0x0403) {
    logger.debug("Initializing FTDI...");

    // Reset
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x00,
      value: 0x00,
      index: 0x00,
    });

    // Set flow control
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x02,
      value: 0x00,
      index: 0x00,
    });

    // Set data characteristics (8N1)
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x04,
      value: 0x0008,
      index: 0x00,
    });

    // Set baudrate
    const baseClock = 3000000;
    const divisor = baseClock / baudRate;
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

    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x03,
      value: value,
      index: index,
    });

    // Set DTR/RTS
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x01,
      value: 0x0303,
      index: 0x00,
    });
  }
  // Prolific PL2303
  else if (vendorId === 0x067b) {
    logger.debug("Initializing PL2303...");
    const vendorRead = async (value: number) => {
      try {
        await controlTransferIn(
          device,
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

    const vendorWrite = async (value: number, index: number) => {
      try {
        await controlTransferOut(device, {
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

    // Set line coding
    const lineCoding = Buffer.alloc(7);
    lineCoding.writeUInt32LE(baudRate, 0);
    lineCoding[4] = 0x00; // 1 stop bit
    lineCoding[5] = 0x00; // No parity
    lineCoding[6] = 0x08; // 8 data bits

    await controlTransferOut(
      device,
      {
        requestType: "class",
        recipient: "interface",
        request: 0x20,
        value: 0,
        index: 0,
      },
      lineCoding,
    );

    // Set control line state
    await controlTransferOut(device, {
      requestType: "class",
      recipient: "interface",
      request: 0x22,
      value: 0x03,
      index: 0,
    });
  }
  // CDC/ACM
  else {
    logger.debug("Initializing CDC/ACM...");

    // Set line coding
    const lineCoding = Buffer.alloc(7);
    lineCoding.writeUInt32LE(baudRate, 0);
    lineCoding[4] = 0x00; // 1 stop bit
    lineCoding[5] = 0x00; // No parity
    lineCoding[6] = 0x08; // 8 data bits

    await controlTransferOut(
      device,
      {
        requestType: "class",
        recipient: "interface",
        request: 0x20,
        value: 0,
        index: 0,
      },
      lineCoding,
    );

    // Set control line state
    await controlTransferOut(device, {
      requestType: "class",
      recipient: "interface",
      request: 0x22,
      value: 0x03,
      index: 0,
    });
  }
}

// Signal setting functions

async function setSignalsCP2102(
  device: Device,
  dtr: boolean,
  rts: boolean,
): Promise<void> {
  // CP2102 uses vendor-specific request 0x07 (SET_MHS)
  // Bit 0: DTR value, Bit 1: RTS value
  // Bit 8: DTR mask (MUST be set to change DTR)
  // Bit 9: RTS mask (MUST be set to change RTS)

  let value = 0;
  value |= dtr ? 1 : 0; // DTR value
  value |= rts ? 2 : 0; // RTS value
  value |= 0x100; // DTR mask (ALWAYS set)
  value |= 0x200; // RTS mask (ALWAYS set)

  await controlTransferOut(device, {
    requestType: "vendor",
    recipient: "device",
    request: 0x07,
    value: value,
    index: 0x00,
  });
}

async function setSignalsCH340(
  device: Device,
  dtr: boolean,
  rts: boolean,
): Promise<void> {
  const value = ~((dtr ? 1 << 5 : 0) | (rts ? 1 << 6 : 0)) & 0xffff;
  let success = false;
  let lastError: Error | null = null;

  try {
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0xa4,
      value: value,
      index: 0,
    });
    success = true;
  } catch (err: any) {
    lastError = err instanceof Error ? err : new Error(String(err));
  }

  try {
    const cdcValue = (dtr ? 1 : 0) | (rts ? 2 : 0);
    await controlTransferOut(device, {
      requestType: "class",
      recipient: "interface",
      request: 0x22,
      value: cdcValue,
      index: 0,
    });
    success = true;
  } catch (err: any) {
    lastError = err instanceof Error ? err : new Error(String(err));
  }

  if (!success) {
    throw lastError || new Error("Failed to set CH340/CH343 signals");
  }
}

function calcCH343Baud(baudRate: number): { value: number; index: number } {
  let b: number, c: number;
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

  const reg_value = 0xc3; // 8 data bits, RX enable, TX enable
  const reg_count = 0x8c;
  const value = (reg_count | (reg_value << 8)) & 0xffff;
  const index = (dvs | (fct << 8)) & 0xffff;
  return { value, index };
}

async function setBaudRateCH343(
  device: Device,
  baudRate: number,
  controlInterface: number = 0,
): Promise<void> {
  let success = false;
  let lastError: Error | null = null;

  // Vendor command CMD_C1 (0xA1) to device endpoint 0
  try {
    const { value, index } = calcCH343Baud(baudRate);
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0xa1, // CMD_C1
      value: value,
      index: index,
    });
    success = true;
  } catch (err: any) {
    lastError = err instanceof Error ? err : new Error(String(err));
  }

  // Also send standard CDC SET_LINE_CODING (0x20)
  try {
    const lineCoding = Buffer.alloc(7);
    lineCoding.writeUInt32LE(baudRate, 0);
    lineCoding[4] = 0x00; // 1 stop bit
    lineCoding[5] = 0x00; // No parity
    lineCoding[6] = 0x08; // 8 data bits

    await controlTransferOut(
      device,
      {
        requestType: "class",
        recipient: "interface",
        request: 0x20,
        value: 0,
        index: controlInterface,
      },
      lineCoding,
    );
    success = true;
  } catch (err: any) {
    lastError = err instanceof Error ? err : new Error(String(err));
  }

  if (!success) {
    throw lastError || new Error("Failed to set CH343 baud rate");
  }
}

async function setSignalsFTDI(
  device: Device,
  dtr: boolean,
  rts: boolean,
): Promise<void> {
  let value = 0;
  value |= dtr ? 1 : 0;
  value |= rts ? 2 : 0;
  value |= 0x0100 | 0x0200; // Masks

  await controlTransferOut(device, {
    requestType: "vendor",
    recipient: "device",
    request: 0x01,
    value: value,
    index: 0x00,
  });
}

async function setSignalsCDC(
  device: Device,
  dtr: boolean,
  rts: boolean,
  interfaceNumber: number,
): Promise<void> {
  let value = 0;
  value |= dtr ? 1 : 0;
  value |= rts ? 2 : 0;

  await controlTransferOut(device, {
    requestType: "class",
    recipient: "interface",
    request: 0x22,
    value: value,
    index: interfaceNumber,
  });
}

// Helper function for control transfers

interface ControlTransferParams {
  requestType: "standard" | "class" | "vendor";
  recipient: "device" | "interface" | "endpoint" | "other";
  request: number;
  value: number;
  index: number;
}

async function controlTransferOut(
  device: Device,
  params: ControlTransferParams,
  data?: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // bmRequestType = Direction | Type | Recipient
    // Direction: 0x00 = Host-to-Device (OUT), 0x80 = Device-to-Host (IN)
    // Type: 0x00 = Standard, 0x20 = Class, 0x40 = Vendor
    // Recipient: 0x00 = Device, 0x01 = Interface, 0x02 = Endpoint, 0x03 = Other
    const bmRequestType =
      0x00 | // Direction: Host-to-Device (OUT)
      (params.requestType === "standard"
        ? 0x00
        : params.requestType === "class"
          ? 0x20
          : 0x40) |
      (params.recipient === "device"
        ? 0x00
        : params.recipient === "interface"
          ? 0x01
          : params.recipient === "endpoint"
            ? 0x02
            : 0x03);

    device.controlTransfer(
      bmRequestType,
      params.request,
      params.value,
      params.index,
      data || Buffer.alloc(0),
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      },
    );
  });
}

async function controlTransferIn(
  device: Device,
  params: ControlTransferParams,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bmRequestType =
      0x80 | // Direction: Device-to-Host (IN)
      (params.requestType === "standard"
        ? 0x00
        : params.requestType === "class"
          ? 0x20
          : 0x40) |
      (params.recipient === "device"
        ? 0x00
        : params.recipient === "interface"
          ? 0x01
          : params.recipient === "endpoint"
            ? 0x02
            : 0x03);

    device.controlTransfer(
      bmRequestType,
      params.request,
      params.value,
      params.index,
      length,
      (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data as Buffer);
        }
      },
    );
  });
}

/**
 * List available USB serial devices
 */
export async function listUSBPorts(): Promise<
  Array<{
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    vendorId?: string;
    productId?: string;
  }>
> {
  try {
    const usb = await import("usb");
    const devices = usb.getDeviceList();

    const serialDevices = devices.filter((device) => {
      const vid = device.deviceDescriptor.idVendor;
      // Filter for known USB-Serial chips
      return knownVendorIds.includes(vid);
    });

    return serialDevices.map((device) => {
      const vid = device.deviceDescriptor.idVendor;
      const pid = device.deviceDescriptor.idProduct;

      return {
        path: `USB:${vid.toString(16)}:${pid.toString(16)}`,
        manufacturer: undefined,
        serialNumber: undefined,
        vendorId: vid.toString(16).padStart(4, "0"),
        productId: pid.toString(16).padStart(4, "0"),
      };
    });
  } catch (err: any) {
    if (
      err.code === "ERR_MODULE_NOT_FOUND" ||
      err.code === "MODULE_NOT_FOUND"
    ) {
      throw new Error("usb package not installed. Run: npm install usb");
    }
    throw err;
  }
}
