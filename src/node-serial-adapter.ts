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
  
  // Track current signal states to avoid unintended flipping
  let currentDTR: boolean = false;
  let currentRTS: boolean = false;
  
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

      // IMPORTANT: When a serial port opens, DTR and RTS are often set to true by default
      // We need to set them to false immediately to prevent unwanted resets
      // Wait a bit after opening to ensure port is stable
      await new Promise(resolve => setTimeout(resolve, 200));

      // Set both signals to false (de-asserted) as initial state
      await new Promise<void>((resolve, reject) => {
        nodePort.set({ dtr: false, rts: false }, (err: Error | null | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      // Track current state
      currentDTR = false;
      currentRTS = false;
      
      // Wait for signals to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));

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
      // Preserve current state for unspecified signals (Web Serial semantics)
      const dtr = signals.dataTerminalReady !== undefined ? signals.dataTerminalReady : currentDTR;
      const rts = signals.requestToSend !== undefined ? signals.requestToSend : currentRTS;
      
      // Update tracked state
      currentDTR = dtr;
      currentRTS = rts;

      // Build options object for Node.js SerialPort
      // Signal polarity varies by platform and USB-Serial chip:
      // - On macOS, node-serialport appears to use SAME polarity as Web Serial API
      // - On Linux/Windows, it may be inverted
      // For now, use non-inverted (same as Web Serial API) and test
      const options: any = {
        dtr: dtr,
        rts: rts,
      };

      if (signals.break !== undefined) {
        options.brk = signals.break;
      }

      if (process.env.DEBUG) {
        logger.debug(`setSignals: DTR=${dtr} (set=${options.dtr}), RTS=${rts} (set=${options.rts})`);
      } else {
        // Always log signal changes for debugging reset issues
        logger.log(`Setting signals: DTR=${dtr}, RTS=${rts}`);
      }

      // ALWAYS set both DTR and RTS to avoid signal flipping on CP2102
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

      // Longer delay to ensure signals are physically set
      // CP2102 and other USB-Serial chips need time to process signal changes
      // macOS may need even more time than other platforms
      await new Promise(resolve => setTimeout(resolve, 100));
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
