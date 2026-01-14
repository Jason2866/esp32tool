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
): NodeSerialPort {
  let readableStream: ReadableStream<Uint8Array> | null = null;
  let writableStream: WritableStream<Uint8Array> | null = null;

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
      return new Promise<void>((resolve, reject) => {
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

        nodePort.set(options, (err: Error | null | undefined) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
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
      // Node.js SerialPort doesn't provide USB vendor/product IDs directly
      // Return empty object to satisfy the interface
      return {
        usbVendorId: undefined,
        usbProductId: undefined,
      };
    },
  };

  return adapter;
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
