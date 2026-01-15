/**
 * Node.js USB Adapter
 *
 * Uses node-usb to directly control USB-Serial chips (CP2102, CH340, FTDI, etc.)
 * This provides the same level of control as WebUSB and avoids node-serialport issues
 */

import { Logger } from "./const";
import type { Device, InEndpoint, OutEndpoint } from "usb";

export interface NodeUSBPort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;

  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;

  setSignals(signals: {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
    break?: boolean;
  }): Promise<void>;

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
      device.open();

      // Select configuration
      try {
        if (device.configDescriptor?.bConfigurationValue !== 1) {
          device.setConfiguration(1);
        }
      } catch (err) {
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
            logger.debug(`Found interface ${interfaceNumber} with IN=0x${inEpNum?.toString(16)}, OUT=0x${outEpNum?.toString(16)}`);
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
      } catch (err) {
        // Ignore - may not be supported on all platforms
      }
      
      usbInterface.claim();

      controlInterface = interfaceNumber;

      // Get the actual endpoints from the claimed interface
      const endpoints = usbInterface.endpoints;
      logger.debug(`Found ${endpoints.length} endpoints on interface ${interfaceNumber}`);
      
      // Find endpoints by address
      endpointIn = endpoints.find(
        (ep: any) => ep.address === endpointInNumber
      ) as InEndpoint;
      endpointOut = endpoints.find(
        (ep: any) => ep.address === endpointOutNumber
      ) as OutEndpoint;

      if (!endpointIn || !endpointOut) {
        throw new Error(`Could not find endpoints: IN=0x${endpointInNumber?.toString(16)}, OUT=0x${endpointOutNumber?.toString(16)}`);
      }
      
      logger.debug(`Endpoints ready: IN=0x${endpointIn.address.toString(16)}, OUT=0x${endpointOut.address.toString(16)}`);

      // Initialize chip-specific settings
      await initializeChip(device, vendorId, productId, baudRate, logger);

      // Create streams
      createStreams();

      logger.log("USB device opened successfully");
    },

    async close() {
      logger.log("Closing USB device...");

      if (readableStream) {
        try {
          await readableStream.cancel();
        } catch (err) {
          // Ignore
        }
        readableStream = null;
      }

      if (writableStream) {
        try {
          await writableStream.close();
        } catch (err) {
          // Ignore
        }
        writableStream = null;
      }

      if (interfaceNumber !== null) {
        try {
          const usbInterface = device.interface(interfaceNumber);
          usbInterface.release(true, () => {});
        } catch (err) {
          // Ignore
        }
      }

      try {
        device.close();
      } catch (err) {
        // Ignore
      }

      logger.log("USB device closed");
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

      logger.log(`Setting signals: DTR=${dtr}, RTS=${rts}`);

      // CP2102 (Silicon Labs VID: 0x10c4)
      if (vendorId === 0x10c4) {
        await setSignalsCP2102(device, dtr, rts);
      }
      // CH340 (WCH VID: 0x1a86, but not CH343 PID: 0x55d3)
      else if (vendorId === 0x1a86 && productId !== 0x55d3) {
        await setSignalsCH340(device, dtr, rts);
      }
      // FTDI (VID: 0x0403)
      else if (vendorId === 0x0403) {
        await setSignalsFTDI(device, dtr, rts);
      }
      // CDC/ACM (CH343, Native USB, etc.)
      else {
        await setSignalsCDC(device, dtr, rts, controlInterface || 0);
      }

      // Wait for signals to stabilize
      await new Promise((resolve) => setTimeout(resolve, 50));
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

    // ReadableStream for incoming data
    readableStream = new ReadableStream({
      start(controller) {
        // Use startPoll for continuous reading
        endpointIn!.startPoll(2, 64);

        endpointIn!.on("data", (data: Buffer) => {
          controller.enqueue(new Uint8Array(data));
        });

        endpointIn!.on("error", (err: Error) => {
          logger.error(`USB read error: ${err.message}`);
          // Don't close on error, just log it
        });

        endpointIn!.on("end", () => {
          controller.close();
        });
      },

      cancel() {
        if (endpointIn) {
          try {
            endpointIn.stopPoll();
          } catch (err) {
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

    // Enable UART
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x00,
      value: 0x01,
      index: 0x00,
    });

    // Set line control (8N1)
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x03,
      value: 0x0800,
      index: 0x00,
    });

    // Set DTR/RTS
    await controlTransferOut(device, {
      requestType: "vendor",
      recipient: "device",
      request: 0x07,
      value: 0x03 | 0x0100 | 0x0200,
      index: 0x00,
    });

    // Set baudrate
    const baudrateBuffer = Buffer.alloc(4);
    baudrateBuffer.writeUInt32LE(baudRate, 0);
    await controlTransferOut(
      device,
      {
        requestType: "vendor",
        recipient: "interface",
        request: 0x1e,
        value: 0,
        index: 0,
      },
      baudrateBuffer,
    );
  }
  // CH340 (WCH)
  else if (vendorId === 0x1a86 && productId !== 0x55d3) {
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
  value |= (dtr ? 1 : 0);  // DTR value
  value |= (rts ? 2 : 0);  // RTS value
  value |= 0x100;          // DTR mask (ALWAYS set)
  value |= 0x200;          // RTS mask (ALWAYS set)

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

  await controlTransferOut(device, {
    requestType: "vendor",
    recipient: "device",
    request: 0xa4,
    value: value,
    index: 0,
  });
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
    const bmRequestType =
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
      return (
        vid === 0x303a || // Espressif
        vid === 0x0403 || // FTDI
        vid === 0x1a86 || // CH340/CH343
        vid === 0x10c4 || // CP210x
        vid === 0x067b
      ); // PL2303
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
    if (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND") {
      throw new Error("usb package not installed. Run: npm install usb");
    }
    throw err;
  }
}
