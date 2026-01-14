#!/usr/bin/env node

/**
 * ESP32Tool CLI - Command Line Interface for ESP device flashing
 *
 * Provides esptool.py-like commands for flashing ESP devices via WebSerial/WebUSB
 *
 * Usage:
 *   esp32tool flash-id
 *   esp32tool read-flash <offset> <size> <filename>
 *   esp32tool write-flash <offset> <filename>
 *   esp32tool erase-flash
 *   esp32tool erase-region <offset> <size>
 *   esp32tool chip-id
 *   esp32tool read-mac
 */

import { ESPLoader } from "./esp_loader";
import { Logger } from "./const";
import { createNodeSerialAdapter, listPorts } from "./node-serial-adapter";
import * as fs from "fs";

// CLI Logger
const cliLogger: Logger = {
  log: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(`ERROR: ${msg}`),
  debug: (msg: string) => {
    if (process.env.DEBUG) {
      console.log(`DEBUG: ${msg}`);
    }
  },
};

// Parse command line arguments
interface CLIArgs {
  command: string;
  args: string[];
  port?: string;
  baudRate?: number;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    process.exit(1);
  }

  const result: CLIArgs = {
    command: "",
    args: [],
    baudRate: 115200,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--port" || arg === "-p") {
      if (i + 1 >= args.length) {
        console.error("Error: --port requires a value");
        process.exit(1);
      }
      result.port = args[++i];
    } else if (arg === "--baud" || arg === "-b") {
      if (i + 1 >= args.length) {
        console.error("Error: --baud requires a value");
        process.exit(1);
      }
      const baud = parseInt(args[++i], 10);
      if (isNaN(baud) || baud <= 0) {
        console.error("Error: --baud must be a positive integer");
        process.exit(1);
      }
      result.baudRate = baud;
    } else if (arg === "--help" || arg === "-h") {
      showHelp();
      process.exit(0);
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.args.push(arg);
    }
    i++;
  }

  return result;
}

function parseHexValue(value: string, paramName: string): number {
  // Remove optional 0x prefix
  const cleanValue = value.toLowerCase().startsWith("0x")
    ? value.slice(2)
    : value;

  // Validate hex format
  if (!/^[0-9a-f]+$/i.test(cleanValue)) {
    throw new Error(
      `Invalid ${paramName}: '${value}' is not a valid hexadecimal value`,
    );
  }

  const parsed = parseInt(cleanValue, 16);

  if (isNaN(parsed)) {
    throw new Error(
      `Invalid ${paramName}: '${value}' could not be parsed as hexadecimal`,
    );
  }

  if (parsed < 0) {
    throw new Error(`Invalid ${paramName}: '${value}' must be non-negative`);
  }

  return parsed;
}

function showHelp() {
  console.log(`
ESP32Tool CLI - Flash ESP devices via WebSerial/WebUSB

Usage: esp32tool [options] <command> [args...]

Options:
  --port, -p <port>      Serial port path (e.g., /dev/ttyUSB0)
  --baud, -b <rate>      Baud rate (default: 115200)
  --help, -h             Show this help message

Commands:
  list-ports             List available serial ports
  chip-id                Read chip ID
  flash-id               Read SPI flash manufacturer and device ID
  read-mac               Read MAC address
  read-flash <offset> <size> <filename>
                         Read flash memory to file
  write-flash <offset> <filename>
                         Write file to flash memory
  erase-flash            Erase entire flash chip
  erase-region <offset> <size>
                         Erase a region of flash
  verify-flash <offset> <filename>
                         Verify flash contents against file

Examples:
  esp32tool list-ports
  esp32tool --port /dev/ttyUSB0 chip-id
  esp32tool --port /dev/ttyUSB0 flash-id
  esp32tool --port /dev/ttyUSB0 read-mac
  esp32tool --port /dev/ttyUSB0 read-flash 0x0 0x400000 flash_dump.bin
  esp32tool --port /dev/ttyUSB0 write-flash 0x1000 bootloader.bin
  esp32tool --port /dev/ttyUSB0 erase-flash
  esp32tool --port /dev/ttyUSB0 erase-region 0x9000 0x6000

Note: This CLI requires Node.js with SerialPort support.
For browser-based usage, use the web interface instead.
`);
}

// Connect to ESP device
async function connectToDevice(
  portPath?: string,
  baudRate: number = 115200,
): Promise<ESPLoader> {
  // List available ports if none specified
  if (!portPath) {
    cliLogger.log("No port specified. Available ports:");
    const ports = await listPorts();

    if (ports.length === 0) {
      throw new Error("No serial ports found");
    }

    ports.forEach((port, idx) => {
      console.log(
        `  [${idx}] ${port.path}${port.manufacturer ? ` (${port.manufacturer})` : ""}`,
      );
    });

    throw new Error("Please specify a port with --port <path>");
  }

  cliLogger.log(`Connecting to ${portPath} at ${baudRate} baud...`);

  let nodePort: any = null;
  let webPort: any = null;

  try {
    // Import serialport package dynamically
    const { SerialPort } = await import("serialport");

    // Create Node.js SerialPort instance
    nodePort = new SerialPort({
      path: portPath,
      baudRate: baudRate,
      autoOpen: false,
    });

    // Open the port
    await new Promise<void>((resolve, reject) => {
      nodePort.open((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Create Web Serial API compatible adapter
    webPort = createNodeSerialAdapter(nodePort, cliLogger);

    // Initialize the adapter's streams
    await webPort.open({ baudRate });

    // Create ESPLoader instance
    const esploader = new ESPLoader(webPort as any, cliLogger);

    // Initialize connection
    await esploader.initialize();

    cliLogger.log(`Connected to ${esploader.chipName || esploader.chipFamily}`);

    return esploader;
  } catch (err: any) {
    // Clean up port on failure
    if (webPort) {
      try {
        await webPort.close();
      } catch (closeErr) {
        // Ignore close errors
      }
    }
    if (nodePort && nodePort.isOpen) {
      try {
        nodePort.close();
      } catch (closeErr) {
        // Ignore close errors
      }
    }

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

// Command implementations
async function cmdChipId(esploader: ESPLoader) {
  cliLogger.log(`Chip Family: ${esploader.chipFamily}`);
  cliLogger.log(`Chip Name: ${esploader.chipName || "Unknown"}`);
  if (esploader.chipRevision !== null) {
    cliLogger.log(`Chip Revision: ${esploader.chipRevision}`);
  }
  if (esploader.chipVariant) {
    cliLogger.log(`Chip Variant: ${esploader.chipVariant}`);
  }
}

async function cmdFlashId(esploader: ESPLoader) {
  // Detect flash size using the stub
  const stub = await esploader.runStub();
  // detectFlashSize() is already called by runStub()
  cliLogger.log(`Flash Size: ${stub.flashSize || "Unknown"}`);
}

async function cmdReadMac(esploader: ESPLoader) {
  const mac = await esploader.getMacAddress();
  cliLogger.log(`MAC Address: ${mac}`);
}

async function cmdReadFlash(
  esploader: ESPLoader,
  offset: number,
  size: number,
  filename: string,
) {
  cliLogger.log(
    `Reading ${size} bytes from offset 0x${offset.toString(16)}...`,
  );

  // Use stub for reading
  const stub = await esploader.runStub();
  const data = await stub.readFlash(offset, size);

  fs.writeFileSync(filename, Buffer.from(data));

  cliLogger.log(`Saved to ${filename}`);
}

async function cmdWriteFlash(
  esploader: ESPLoader,
  offset: number,
  filename: string,
) {
  if (!fs.existsSync(filename)) {
    throw new Error(`File not found: ${filename}`);
  }

  const fileData = fs.readFileSync(filename);
  const size = fileData.byteLength;

  cliLogger.log(`Writing ${size} bytes to offset 0x${offset.toString(16)}...`);

  // Use stub for writing
  const stub = await esploader.runStub();

  // Write flash using the stub's flash methods
  // Create a proper ArrayBuffer from the Buffer to avoid byteOffset issues
  // Node.js Buffer can share an underlying ArrayBuffer with non-zero byteOffset
  const arrayBuffer = fileData.buffer.slice(
    fileData.byteOffset,
    fileData.byteOffset + fileData.byteLength,
  );
  await stub.flashData(
    arrayBuffer,
    (bytesWritten: number, totalBytes: number) => {
      const percent = Math.round((bytesWritten / totalBytes) * 100);
      process.stdout.write(
        `\rProgress: ${percent}% (${bytesWritten}/${totalBytes} bytes)`,
      );
    },
    offset,
  );

  console.log(""); // New line after progress
  cliLogger.log("Write complete!");
}

async function cmdEraseFlash(esploader: ESPLoader) {
  cliLogger.log("Erasing entire flash chip...");

  // Use stub for erasing
  const stub = await esploader.runStub();

  // Erase flash
  await stub.eraseFlash();

  cliLogger.log("Erase complete!");
}

async function cmdEraseRegion(
  esploader: ESPLoader,
  offset: number,
  size: number,
) {
  cliLogger.log(
    `Erasing region: offset=0x${offset.toString(16)}, size=0x${size.toString(16)}...`,
  );

  // Use stub for erasing
  const stub = await esploader.runStub();

  // Erase region
  await stub.eraseRegion(offset, size);

  cliLogger.log("Erase complete!");
}

async function cmdVerifyFlash(
  esploader: ESPLoader,
  offset: number,
  filename: string,
) {
  if (!fs.existsSync(filename)) {
    throw new Error(`File not found: ${filename}`);
  }

  const fileData = fs.readFileSync(filename);
  const size = fileData.length;

  cliLogger.log(
    `Verifying ${size} bytes at offset 0x${offset.toString(16)}...`,
  );

  // Use stub for reading
  const stub = await esploader.runStub();
  const flashData = await stub.readFlash(offset, size);

  if (Buffer.compare(Buffer.from(flashData), fileData) === 0) {
    cliLogger.log("Verification successful!");
  } else {
    throw new Error("Verification failed! Flash contents do not match file.");
  }
}

// Main CLI entry point
async function main() {
  const cliArgs = parseArgs();

  let esploader: ESPLoader | null = null;

  try {
    // Special command: list-ports (doesn't need device connection)
    if (cliArgs.command === "list-ports") {
      const ports = await listPorts();

      if (ports.length === 0) {
        cliLogger.log("No serial ports found");
      } else {
        cliLogger.log("Available serial ports:");
        ports.forEach((port) => {
          console.log(
            `  ${port.path}${port.manufacturer ? ` (${port.manufacturer})` : ""}${port.serialNumber ? ` [${port.serialNumber}]` : ""}`,
          );
        });
      }
      process.exit(0);
    }

    // Connect to device
    esploader = await connectToDevice(cliArgs.port, cliArgs.baudRate);

    // Execute command
    switch (cliArgs.command) {
      case "chip-id":
        await cmdChipId(esploader);
        break;

      case "flash-id":
        await cmdFlashId(esploader);
        break;

      case "read-mac":
        await cmdReadMac(esploader);
        break;

      case "read-flash": {
        if (cliArgs.args.length < 3) {
          throw new Error("read-flash requires: <offset> <size> <filename>");
        }
        const offset = parseHexValue(cliArgs.args[0], "offset");
        const size = parseHexValue(cliArgs.args[1], "size");
        const filename = cliArgs.args[2];
        await cmdReadFlash(esploader, offset, size, filename);
        break;
      }

      case "write-flash": {
        if (cliArgs.args.length < 2) {
          throw new Error("write-flash requires: <offset> <filename>");
        }
        const offset = parseHexValue(cliArgs.args[0], "offset");
        const filename = cliArgs.args[1];
        await cmdWriteFlash(esploader, offset, filename);
        break;
      }

      case "erase-flash":
        await cmdEraseFlash(esploader);
        break;

      case "erase-region": {
        if (cliArgs.args.length < 2) {
          throw new Error("erase-region requires: <offset> <size>");
        }
        const offset = parseHexValue(cliArgs.args[0], "offset");
        const size = parseHexValue(cliArgs.args[1], "size");
        await cmdEraseRegion(esploader, offset, size);
        break;
      }

      case "verify-flash": {
        if (cliArgs.args.length < 2) {
          throw new Error("verify-flash requires: <offset> <filename>");
        }
        const offset = parseHexValue(cliArgs.args[0], "offset");
        const filename = cliArgs.args[1];
        await cmdVerifyFlash(esploader, offset, filename);
        break;
      }

      default:
        throw new Error(`Unknown command: ${cliArgs.command}`);
    }

    // Disconnect
    await esploader.disconnect();
    process.exit(0);
  } catch (error: any) {
    // Clean up device connection on failure
    if (esploader) {
      try {
        await esploader.disconnect();
      } catch (disconnectErr) {
        // Ignore disconnect errors during error handling
      }
    }

    cliLogger.error(error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run CLI - only execute when this file is run directly (not when imported)
// Check if we're being run directly by Node.js (not imported by Electron)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("/cli.js") ||
    process.argv[1].endsWith("\\cli.js") ||
    process.argv[1].endsWith("/cli-fixed.js") ||
    process.argv[1].endsWith("\\cli-fixed.js") ||
    process.argv[1].endsWith("/esp32tool") ||
    process.argv[1].endsWith("\\esp32tool"));

if (isDirectRun) {
  main();
}

export { main as runCLI };
