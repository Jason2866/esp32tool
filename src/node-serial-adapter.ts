/**
 * Node.js SerialPort Adapter
 *
 * Adapts Node.js SerialPort to work with ESPLoader
 */

import { Logger } from "./const";

// Minimal SerialPort interface compatible with Web Serial API
export interface NodeSerialPort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  //  isWebUSB?: boolean; // Flag to indicate this behaves like WebUSB

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
 * Create a Web Serial API compatible port from Node.js SerialPort
 *
 * Usage:
 *   const { SerialPort } = require('serialport');
 *   const nodePort = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 });
 *   const webPort = createNodeSerialAdapter(nodePort, logger);
 *   const esploader = new ESPLoader(webPort, logger);
 */
export function createNodeSerialAdapter(
  nodePort: any, // Node.js SerialPort instance
  logger: Logger,
): NodeSerialPort {
  let readableStream: ReadableStream<Uint8Array> | null = null;
  let writableStream: WritableStream<Uint8Array> | null = null;

  // Track current signal states
  let currentDTR: boolean = false;
  let currentRTS: boolean = false;

  // Get USB vendor/product IDs from port info
  const portInfo = nodePort.port || {};
  const vendorId = portInfo.vendorId ? parseInt(portInfo.vendorId, 16) : undefined;
  const productId = portInfo.productId ? parseInt(portInfo.productId, 16) : undefined;

  const adapter: NodeSerialPort = {
    get readable() {
      return readableStream;
    },

    get writable() {
      return writableStream;
    },

    async open(options: { baudRate: number }) {
      // Prevent multiple opens
      if (readableStream || writableStream) {
        throw new Error("Port is already open");
      }

      logger.log(`Opening port at ${options.baudRate} baud...`);

      // Re-open nodePort if it was closed
      if (!nodePort.isOpen) {
        await new Promise<void>((resolve, reject) => {
          nodePort.open((err: Error | null | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Update baud rate if needed
      if (nodePort.baudRate !== options.baudRate) {
        await nodePort.update({ baudRate: options.baudRate });
      }

      try {
        // Create readable stream
        readableStream = new ReadableStream({
          start(controller) {
            nodePort.on("data", (data: Buffer) => {
              controller.enqueue(new Uint8Array(data));
            });

            nodePort.on("close", () => {
              controller.close();
            });

            nodePort.on("error", (err: Error) => {
              controller.error(err);
            });
          },

          cancel() {
            // Clean up listeners
            nodePort.removeAllListeners("data");
            nodePort.removeAllListeners("close");
            nodePort.removeAllListeners("error");
          },
        });

        // Create writable stream
        writableStream = new WritableStream({
          async write(chunk: Uint8Array) {
            return new Promise((resolve, reject) => {
              nodePort.write(
                Buffer.from(chunk),
                (err: Error | null | undefined) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve();
                  }
                },
              );
            });
          },

          async close() {
            await nodePort.drain();
          },
        });
      } catch (err) {
        // Clean up readable stream if writable stream creation fails
        if (readableStream) {
          try {
            await readableStream.cancel();
          } catch (cancelErr) {
            // Ignore cancel errors
          }
          readableStream = null;
        }
        throw err;
      }

      logger.log("Port opened successfully");
    },

    async close() {
      logger.log("Closing port...");

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

      return new Promise<void>((resolve, reject) => {
        if (!nodePort.isOpen) {
          resolve();
          return;
        }

        nodePort.close((err: Error | null | undefined) => {
          if (err) {
            reject(err);
          } else {
            logger.log("Port closed");
            resolve();
          }
        });
      });
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

      // Use chip-specific signal setting if vendor ID is known
      if (vendorId) {
        // CP2102 (Silicon Labs VID: 0x10c4)
        if (vendorId === 0x10c4) {
          await setSignalsCP2102ViaSerialPort(nodePort, dtr, rts);
        }
        // CH340 (WCH VID: 0x1a86, but not CH343 PID: 0x55d3)
        else if (vendorId === 0x1a86 && productId !== 0x55d3) {
          await setSignalsCH340ViaSerialPort(nodePort, dtr, rts);
        }
        // For other chips, use standard SerialPort API
        else {
          await setSignalsStandard(nodePort, dtr, rts);
        }
      } else {
        // Fallback to standard SerialPort API if vendor ID unknown
        await setSignalsStandard(nodePort, dtr, rts);
      }

      // Match WebUSB timing - 50ms delay is critical for bootloader entry
      await new Promise((resolve) => setTimeout(resolve, 50));
    },

    async getSignals() {
      return new Promise<{
        dataCarrierDetect: boolean;
        clearToSend: boolean;
        ringIndicator: boolean;
        dataSetReady: boolean;
      }>((resolve, reject) => {
        nodePort.get((err: Error | null | undefined, status: any) => {
          if (err) {
            reject(err);
          } else {
            resolve({
              dataCarrierDetect: status.dcd || false,
              clearToSend: status.cts || false,
              ringIndicator: status.ri || false,
              dataSetReady: status.dsr || false,
            });
          }
        });
      });
    },

    getInfo() {
      // Return USB vendor/product IDs from port info
      return {
        usbVendorId: vendorId,
        usbProductId: productId,
      };
    },
  };

  return adapter;
}

// Chip-specific signal setting functions using SerialPort low-level access

/**
 * Set signals for CP2102 using vendor-specific control
 * CP2102 requires special handling with mask bits
 */
async function setSignalsCP2102ViaSerialPort(
  nodePort: any,
  dtr: boolean,
  rts: boolean,
): Promise<void> {
  // CP2102 uses vendor-specific request 0x07 (SET_MHS)
  // Bit 0: DTR value, Bit 1: RTS value
  // Bit 8: DTR mask (MUST be set to change DTR)
  // Bit 9: RTS mask (MUST be set to change RTS)

  await setSignalsStandard(nodePort, dtr, rts);
}

/**
 * Set signals for CH340 using vendor-specific control
 */
async function setSignalsCH340ViaSerialPort(
  nodePort: any,
  dtr: boolean,
  rts: boolean,
): Promise<void> {
  // CH340 uses inverted logic for DTR/RTS

  // Fallback: Use standard SerialPort API
  await setSignalsStandard(nodePort, dtr, rts);
}

/**
 * Standard SerialPort signal setting (fallback)
 */
async function setSignalsStandard(
  nodePort: any,
  dtr: boolean,
  rts: boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const options: any = {
      dtr: dtr,
      rts: rts,
    };

    nodePort.set(options, (err: Error | null | undefined) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * List available serial ports
 */
export async function listPorts(): Promise<
  Array<{ path: string; manufacturer?: string; serialNumber?: string }>
> {
  try {
    const { SerialPort } = await import("serialport");
    const ports = await SerialPort.list();
    return ports.map((port: any) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
    }));
  } catch (err: any) {
    throw err;
  }
}
