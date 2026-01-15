/**
 * Node.js SerialPort Adapter
 *
 * Adapts Node.js SerialPort to work with ESPLoader (designed for Web Serial API)
 */

import { Logger } from "./const";

// Minimal SerialPort interface compatible with Web Serial API
export interface NodeSerialPort {
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
  portInfo?: { vendorId?: string; productId?: string },
): NodeSerialPort {
  let readableStream: ReadableStream<Uint8Array> | null = null;
  let writableStream: WritableStream<Uint8Array> | null = null;
  
  // Parse VID/PID from hex strings to numbers
  const cachedPortInfo: { usbVendorId?: number; usbProductId?: number } = {
    usbVendorId: portInfo?.vendorId ? parseInt(portInfo.vendorId, 16) : undefined,
    usbProductId: portInfo?.productId ? parseInt(portInfo.productId, 16) : undefined,
  };

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
        
        // Wait a bit after opening to ensure port is ready
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Update baud rate if needed
      if (nodePort.baudRate !== options.baudRate) {
        await nodePort.update({ baudRate: options.baudRate });
        // Wait after baud rate change
        await new Promise(resolve => setTimeout(resolve, 50));
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
      // Build options object for Node.js SerialPort
      const options: any = {};

      if (signals.dataTerminalReady !== undefined) {
        options.dtr = signals.dataTerminalReady;
      }

      if (signals.requestToSend !== undefined) {
        options.rts = signals.requestToSend;
      }

      if (signals.break !== undefined) {
        options.brk = signals.break;
      }

      // If no signals to set, return immediately
      if (Object.keys(options).length === 0) {
        return;
      }

      // Use nodePort.set() for setting signals
      await new Promise<void>((resolve, reject) => {
        nodePort.set(options, (err: Error | null | undefined) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      // Small delay to ensure signals are physically set
      // Reduced from 50ms to 10ms for faster reset sequences
      await new Promise(resolve => setTimeout(resolve, 10));
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
      // Return cached port info (VID/PID) if available
      return {
        usbVendorId: cachedPortInfo.usbVendorId,
        usbProductId: cachedPortInfo.usbProductId,
      };
    },
  };

  return adapter;
}

/**
 * List available serial ports
 */
export async function listPorts(): Promise<
  Array<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }>
> {
  try {
    const { SerialPort } = await import("serialport");
    const ports = await SerialPort.list();
    return ports.map((port: any) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      vendorId: port.vendorId,
      productId: port.productId,
    }));
  } catch (err: any) {
    if (
      err.code === "ERR_MODULE_NOT_FOUND" ||
      err.code === "MODULE_NOT_FOUND"
    ) {
      throw new Error(
        "serialport package not installed. Run: npm install serialport",
      );
    }
    throw err;
  }
}
