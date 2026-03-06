# ESP32Tool API Reference

Complete API documentation for the ESP32Tool JavaScript/TypeScript library (v1.6.3).

The library can be used as an ES module in the browser (via WebSerial/WebUSB) or in Node.js (via the `serialport` package).

---

## Table of Contents

- [Getting Started](#getting-started)
- [Connection Functions](#connection-functions)
- [ESPLoader Class](#esploader-class)
  - [Properties](#properties)
  - [Initialization](#initialization)
  - [Chip Information](#chip-information)
  - [Flash Operations](#flash-operations)
  - [Memory Operations](#memory-operations)
  - [Register Access](#register-access)
  - [Baudrate Control](#baudrate-control)
  - [Reset & Reconnect](#reset--reconnect)
  - [Console Mode](#console-mode)
  - [Connection Management](#connection-management)
  - [Events](#events)
- [EspStubLoader Class](#espstubloader-class)
- [Partition Table](#partition-table)
- [Filesystem Detection](#filesystem-detection)
- [SPIFFS Module](#spiffs-module)
- [Utility Functions](#utility-functions)
- [Constants](#constants)
- [Type Definitions](#type-definitions)

---

## Getting Started

### Browser (ES Module)

```html
<script type="module">
  import { connect, ESPLoader } from "./js/modules/esptool.js";

  const logger = {
    log: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
    debug: (msg) => console.debug(msg),
  };

  const esploader = await connect(logger);
  await esploader.initialize();
</script>
```

### TypeScript / Node.js

```typescript
import { ESPLoader, Logger } from "esp32tool";
```

---

## Connection Functions

### `connect(logger: Logger): Promise<ESPLoader>`

Opens a serial port selection dialog (Web Serial API) and creates an `ESPLoader` instance.

- Supports `WebUSB` on Android via a custom `requestSerialPort` global function.
- Automatically opens the port at 115200 baud (ROM default).
- Throws an error if Web Serial API is not available.

```typescript
const esploader = await connect(logger);
```

### `connectWithPort(port: SerialPort, logger: Logger): Promise<ESPLoader>`

Creates an `ESPLoader` instance from an already-obtained `SerialPort`. Useful for WebUSB wrappers or when managing ports manually.

```typescript
const port = await navigator.serial.requestPort();
const esploader = await connectWithPort(port, logger);
```

---

## ESPLoader Class

The main class for communicating with ESP devices. Extends `EventTarget` for event-driven communication.

```typescript
class ESPLoader extends EventTarget
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `port` | `SerialPort` | The underlying serial port |
| `logger` | `Logger` | Logger instance for output |
| `chipFamily` | `ChipFamily` | Detected chip family (e.g., `CHIP_FAMILY_ESP32S3`) |
| `chipName` | `string \| null` | Human-readable chip name (e.g., `"ESP32-S3"`) |
| `chipRevision` | `number \| null` | Chip silicon revision |
| `chipVariant` | `string \| null` | Chip variant string |
| `flashSize` | `string \| null` | Detected flash size (e.g., `"4MB"`) |
| `connected` | `boolean` | Connection state |
| `IS_STUB` | `boolean` | Whether the stub loader is running |
| `currentBaudRate` | `number` | Current serial baudrate |
| `isUsbJtagOrOtg` | `boolean \| undefined` | Whether USB-JTAG or USB-OTG is used (not external serial chip) |

---

### Initialization

#### `initialize(): Promise<void>`

Connects to the ESP device, detects the chip type, reads efuses, and prepares the device for further operations. Must be called after creating an `ESPLoader` instance.

```typescript
const esploader = await connect(logger);
await esploader.initialize();
console.log(`Connected to ${esploader.chipName}`);
```

**What it does:**
1. Detects USB-Serial chip type (CP2102, CH340, FTDI, etc.)
2. Connects using multiple reset strategies (classic, USB-JTAG)
3. Detects chip family and revision
4. Detects USB connection type (JTAG/OTG vs. external serial)
5. Reads efuse data (MAC address, etc.)

---

### Chip Information

#### `detectChip(): Promise<void>`

Detects the chip type using `GET_SECURITY_INFO` (for ESP32-C3 and later) or magic register values (for older chips like ESP32, ESP8266).

#### `getChipFamily(): ChipFamily`

Returns the chip family constant.

#### `getSecurityInfo(): Promise<SecurityInfo>`

Returns security information for the connected chip (ESP32-C3 and later).

```typescript
const info = await esploader.getSecurityInfo();
// { flags, flashCryptCnt, keyPurposes, chipId, apiVersion }
```

#### `getMacAddress(): Promise<string>`

Returns the MAC address as a formatted string (e.g., `"AA:BB:CC:DD:EE:FF"`). Requires `initialize()` to have completed successfully.

```typescript
const mac = await esploader.getMacAddress();
console.log(`MAC: ${mac}`); // "AA:BB:CC:DD:EE:FF"
```

#### `macAddr(): number[]`

Returns the raw MAC address as a 6-byte array from efuse data.

#### `flashId(): Promise<number>`

Reads the SPI flash manufacturer and device ID using the JEDEC RDID command.

#### `detectFlashSize(): Promise<void>`

Auto-detects the flash size and stores it in `esploader.flashSize`. Logs the flash manufacturer and device information.

```typescript
await esploader.detectFlashSize();
console.log(`Flash: ${esploader.flashSize}`); // e.g., "4MB"
```

#### `getBootloaderOffset(): number`

Returns the bootloader flash offset for the current chip family.

---

### Flash Operations

#### `runStub(skipFlashDetection?: boolean): Promise<EspStubLoader>`

Uploads and starts the stub loader on the device. The stub loader provides faster flash operations and additional capabilities.

Returns an `EspStubLoader` instance (a subclass of `ESPLoader`) that should be used for all subsequent operations.

```typescript
const stub = await esploader.runStub();
// Use 'stub' for flash operations from now on
```

**Parameters:**
- `skipFlashDetection` (optional, default: `false`) – Skip automatic flash size detection after stub upload.

#### `flashData(binaryData, updateProgress, offset?, compress?): Promise<void>`

Writes a binary file to flash memory at a given offset.

```typescript
const firmware = await fetch("firmware.bin").then((r) => r.arrayBuffer());
await stub.flashData(
  firmware,
  (written, total) => console.log(`${written}/${total}`),
  0x10000,  // offset
  true,     // use compression
);
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `binaryData` | `ArrayBuffer` | — | Binary data to flash |
| `updateProgress` | `(bytesWritten: number, totalBytes: number) => void` | — | Progress callback |
| `offset` | `number` | `0` | Flash address offset |
| `compress` | `boolean` | `false` | Use zlib compression (faster) |

#### `flashBegin(size?, offset?, encrypted?): Promise<number>`

Prepares for flashing by attaching the SPI chip and erasing the required number of blocks. Returns the number of blocks.

#### `flashBlock(data, seq, timeout?): Promise<void>`

Sends one block of uncompressed data to flash memory.

#### `flashDeflBegin(size?, compressedSize?, offset?): Promise<number>`

Prepares for compressed flash writing. Returns the erase timeout.

#### `flashDeflBlock(data, seq, timeout?): Promise<void>`

Sends one block of compressed data to flash memory.

#### `flashFinish(): Promise<void>`

Completes an uncompressed flash write operation.

#### `flashDeflFinish(): Promise<void>`

Completes a compressed flash write operation.

#### `readFlash(addr, size, onPacketReceived?, options?): Promise<Uint8Array>`

Reads flash memory from the chip. **Requires stub loader** (`runStub()` must be called first).

```typescript
const data = await stub.readFlash(
  0x0,        // start address
  0x400000,   // size (4MB)
  (packet, progress, total) => {
    console.log(`${progress}/${total} bytes`);
  },
);
```

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `addr` | `number` | Flash address to read from |
| `size` | `number` | Number of bytes to read |
| `onPacketReceived` | `(packet: Uint8Array, progress: number, totalSize: number) => void` | Optional progress callback |
| `options.chunkSize` | `number` | Bytes per read command (default: auto) |
| `options.blockSize` | `number` | Bytes per data block from ESP (default: auto) |
| `options.maxInFlight` | `number` | Max unacknowledged bytes (default: auto) |

**Notes:**
- Automatically adapts speed for WebUSB (Android) vs. Web Serial (Desktop)
- Includes automatic retry with recovery on read errors (up to 5 retries per chunk)

---

### Memory Operations

#### `memBegin(size, blocks, blocksize, offset): Promise<[number, number[]]>`

Starts downloading an application image to RAM.

#### `memBlock(data, seq): Promise<[number, number[]]>`

Sends a block of data to RAM.

#### `memFinish(entrypoint?): Promise<[number, number[]]>`

Finishes RAM download and optionally starts execution at the given entry point.

---

### Register Access

#### `readRegister(reg: number): Promise<number>`

Reads a 32-bit value from a hardware register.

```typescript
const value = await esploader.readRegister(0x3ff5a000);
```

#### `writeRegister(address, value, mask?, delayUs?, delayAfterUs?): Promise<void>`

Writes a 32-bit value to a hardware register.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `address` | `number` | — | Register address |
| `value` | `number` | — | Value to write |
| `mask` | `number` | `0xFFFFFFFF` | Write mask |
| `delayUs` | `number` | `0` | Delay before write (µs) |
| `delayAfterUs` | `number` | `0` | Delay after write (µs) |

#### `checkCommand(opcode, buffer, checksum?, timeout?): Promise<[number, number[]]>`

Sends a raw command packet and validates the response. Returns `[value, data]`.

---

### Baudrate Control

#### `setBaudrate(baud: number): Promise<void>`

Changes the serial communication baudrate on both the ESP device and the host port. Warns if the baudrate exceeds the USB-Serial chip's capability.

```typescript
await stub.setBaudrate(921600);
```

**Supported baud rates:** 115200, 230400, 460800, 921600, 2000000

---

### Reset & Reconnect

#### `hardReset(bootloader?: boolean): Promise<void>`

Performs a hardware reset.

- `bootloader = true` — Reset into bootloader/flash mode
- `bootloader = false` (default) — Reset to run firmware

Automatically selects the appropriate reset strategy (classic, USB-JTAG, WDT reset) based on the chip and connection type.

#### `resetToFirmware(): Promise<boolean>`

Resets the device to run firmware. Returns `true` if the port will change (USB-OTG/JTAG devices), meaning the user must reselect the port.

```typescript
const portChanged = await esploader.resetToFirmware();
if (portChanged) {
  console.log("Please select the new port");
}
```

---

### Console Mode

#### `exitConsoleMode(): Promise<boolean>`

Exits console mode and returns to the bootloader. Returns `true` if manual port reconnection is needed (USB-OTG devices like ESP32-S2).

#### `isConsoleResetSupported(): boolean`

Returns whether console reset is supported for this device. ESP32-S2 via USB-JTAG/CDC does not support reset in console mode (hardware limitation).

---

### Connection Management

#### `disconnect(): Promise<void>`

Closes the serial port connection and releases all resources. Waits for pending writes to complete.

```typescript
await esploader.disconnect();
```

---

### Events

`ESPLoader` extends `EventTarget` and emits custom events for loose coupling with UI code.

| Event | Detail | Description |
|-------|--------|-------------|
| `usb-otg-port-change` | `{ chipName, message, reason }` | USB-OTG port changed (need to reselect port) |

```typescript
esploader.addEventListener("usb-otg-port-change", (e) => {
  console.log(e.detail.message);
});
```

---

## EspStubLoader Class

Extends `ESPLoader`. Created by calling `runStub()`. Provides additional flash operations.

```typescript
class EspStubLoader extends ESPLoader
```

### Additional Methods

#### `eraseFlash(): Promise<void>`

Erases the entire flash chip. **Warning: This erases all data!**

```typescript
await stub.eraseFlash();
```

#### `eraseRegion(offset: number, size: number): Promise<void>`

Erases a specific region of flash. Both `offset` and `size` must be aligned to the flash sector size (4096 bytes / 0x1000).

```typescript
await stub.eraseRegion(0x9000, 0x6000);
```

---

## Partition Table

### `parsePartitionTable(data: Uint8Array): Partition[]`

Parses binary partition table data into an array of `Partition` objects.

```typescript
import { parsePartitionTable } from "esp32tool";

const partData = await stub.readFlash(0x8000, 0xC00);
const partitions = parsePartitionTable(partData);
partitions.forEach((p) => {
  console.log(`${p.name}: ${p.typeName}/${p.subtypeName} @ 0x${p.offset.toString(16)}, size: ${formatSize(p.size)}`);
});
```

### `formatSize(bytes: number): string`

Formats a byte count into a human-readable string (e.g., `"4.00 MB"`, `"256.00 KB"`).

### `Partition` Interface

```typescript
interface Partition {
  name: string;        // Partition name (e.g., "factory", "nvs", "spiffs")
  type: number;        // Partition type (0x00 = app, 0x01 = data)
  subtype: number;     // Partition subtype
  offset: number;      // Start offset in flash
  size: number;        // Size in bytes
  flags: number;       // Partition flags
  typeName: string;    // Human-readable type (e.g., "app", "data")
  subtypeName: string; // Human-readable subtype (e.g., "factory", "spiffs")
}
```

---

## Filesystem Detection

### `FilesystemType` Enum

```typescript
enum FilesystemType {
  UNKNOWN = "unknown",
  LITTLEFS = "littlefs",
  FATFS = "fatfs",
  SPIFFS = "spiffs",
}
```

### `detectFilesystemFromImage(imageData: Uint8Array, chipName?: string): FilesystemType`

Detects the filesystem type from binary image data by checking for magic signatures (LittleFS superblock, FAT boot sector, SPIFFS patterns).

```typescript
const fsData = await stub.readFlash(partition.offset, partition.size);
const fsType = detectFilesystemFromImage(fsData, esploader.chipName);
console.log(`Filesystem: ${fsType}`); // "littlefs", "fatfs", "spiffs", or "unknown"
```

### `detectFilesystemType(partition: Partition): FilesystemType`

Detects filesystem type from partition subtype. Only provides a hint — use `detectFilesystemFromImage()` for accurate detection.

### `getDefaultBlockSize(fsType: FilesystemType, chipName?: string): number`

Returns the default block size for a filesystem type. ESP8266 uses different block sizes (8192) than ESP32 (4096).

### `getBlockSizeCandidates(fsType: FilesystemType, chipName?: string): number[]`

Returns an array of block size candidates to try for a given filesystem and chip.

### `scanESP8266Filesystem(flashData, scanOffset, flashSize): ESP8266FilesystemLayout | null`

Scans ESP8266 flash data for LittleFS/SPIFFS filesystem signatures and returns the detected layout.

### `getESP8266FilesystemLayout(flashSizeMB: number): ESP8266FilesystemLayout[]`

Returns common ESP8266 filesystem layouts as fallback when flash scanning is not possible.

### `ESP8266FilesystemLayout` Interface

```typescript
interface ESP8266FilesystemLayout {
  start: number;  // Start address in flash
  end: number;    // End address in flash
  size: number;   // Filesystem size in bytes
  page: number;   // Page size (typically 256)
  block: number;  // Block size (typically 8192)
}
```

---

## SPIFFS Module

### `SpiffsFS`

Main SPIFFS filesystem class for reading and writing SPIFFS images.

### `SpiffsReader`

Reader class for extracting files from SPIFFS filesystem images.

### `SpiffsBuildConfig`

Configuration class for building SPIFFS filesystem images.

### `DEFAULT_SPIFFS_CONFIG`

Default ESP32 SPIFFS configuration:

```typescript
const DEFAULT_SPIFFS_CONFIG = {
  pageSize: 256,
  blockSize: 4096,
  objNameLen: 32,
  metaLen: 4,
  useMagic: true,
  useMagicLen: true,
  alignedObjIxTables: false,
};
```

### Types

```typescript
interface SpiffsFile {
  // File entry from a SPIFFS filesystem
}

interface SpiffsBuildConfigOptions {
  // Options for building SPIFFS images
}
```

---

## Utility Functions

### `toHex(value: number, size?: number): string`

Converts a number to a hex string with `0x` prefix, padded to the given size.

```typescript
toHex(255);       // "0xFF"
toHex(4096, 4);   // "0x1000"
toHex(-1);        // "-0x01"
```

### `sleep(ms: number): Promise<void>`

Asynchronous delay function.

```typescript
await sleep(1000); // Wait 1 second
```

### `hexFormatter(bytes: number[]): string`

Formats a byte array as a hex string for debugging.

```typescript
hexFormatter([0xDE, 0xAD]);  // "[0xDE, 0xAD]"
```

### `formatMacAddr(macAddr: number[]): string`

Formats a MAC address byte array as a colon-separated hex string.

```typescript
formatMacAddr([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
// "AA:BB:CC:DD:EE:FF"
```

---

## Constants

### Chip Family Constants

| Constant | Description |
|----------|-------------|
| `CHIP_FAMILY_ESP8266` | ESP8266 |
| `CHIP_FAMILY_ESP32` | ESP32 |
| `CHIP_FAMILY_ESP32S2` | ESP32-S2 |
| `CHIP_FAMILY_ESP32S3` | ESP32-S3 |
| `CHIP_FAMILY_ESP32S31` | ESP32-S3 (variant) |
| `CHIP_FAMILY_ESP32C2` | ESP32-C2 |
| `CHIP_FAMILY_ESP32C3` | ESP32-C3 |
| `CHIP_FAMILY_ESP32C5` | ESP32-C5 |
| `CHIP_FAMILY_ESP32C6` | ESP32-C6 |
| `CHIP_FAMILY_ESP32C61` | ESP32-C61 |
| `CHIP_FAMILY_ESP32H2` | ESP32-H2 |
| `CHIP_FAMILY_ESP32H4` | ESP32-H4 |
| `CHIP_FAMILY_ESP32H21` | ESP32-H21 |
| `CHIP_FAMILY_ESP32P4` | ESP32-P4 |

### Command Constants

| Constant | Description |
|----------|-------------|
| `ESP_FLASH_BEGIN` | Begin flash write |
| `ESP_FLASH_DATA` | Flash data block |
| `ESP_FLASH_END` | End flash write |
| `ESP_FLASH_DEFL_BEGIN` | Begin compressed flash write |
| `ESP_FLASH_DEFL_DATA` | Compressed flash data block |
| `ESP_FLASH_DEFL_END` | End compressed flash write |
| `ESP_MEM_BEGIN` | Begin memory write |
| `ESP_MEM_DATA` | Memory data block |
| `ESP_MEM_END` | End memory write / start execution |
| `ESP_SYNC` | Sync command |
| `ESP_WRITE_REG` | Write register |
| `ESP_READ_REG` | Read register |
| `ESP_READ_FLASH` | Read flash |
| `ESP_ERASE_FLASH` | Erase entire flash |
| `ESP_ERASE_REGION` | Erase flash region |
| `ESP_SPI_SET_PARAMS` | Set SPI parameters |
| `ESP_SPI_ATTACH` | Attach SPI flash |
| `ESP_CHANGE_BAUDRATE` | Change baudrate |
| `ESP_SPI_FLASH_MD5` | Flash MD5 checksum |
| `ESP_GET_SECURITY_INFO` | Get security info |
| `ESP_CHECKSUM_MAGIC` | Checksum magic value |

### Block Size Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `USB_RAM_BLOCK` | — | RAM block size for USB transfers |
| `ESP_RAM_BLOCK` | — | RAM block size for ESP operations |

### Timeout Constants

| Constant | Description |
|----------|-------------|
| `DEFAULT_TIMEOUT` | Default command timeout |
| `CHIP_ERASE_TIMEOUT` | Timeout for full chip erase |
| `MAX_TIMEOUT` | Maximum allowed timeout |
| `SYNC_TIMEOUT` | Timeout for sync command |
| `ERASE_REGION_TIMEOUT_PER_MB` | Per-MB timeout for region erase |
| `MEM_END_ROM_TIMEOUT` | Timeout for memory end command (ROM) |
| `FLASH_READ_TIMEOUT` | Timeout for flash read operations |

### Filesystem Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `LITTLEFS_DEFAULT_BLOCK_SIZE` | `4096` | Default LittleFS block size (ESP32) |
| `LITTLEFS_BLOCK_SIZE_CANDIDATES` | `[4096, 2048, 1024, 512]` | LittleFS block size candidates |
| `FATFS_DEFAULT_BLOCK_SIZE` | `4096` | Default FATFS block size |
| `FATFS_BLOCK_SIZE_CANDIDATES` | `[4096, 2048, 1024, 512]` | FATFS block size candidates |
| `ESP8266_LITTLEFS_BLOCK_SIZE` | `8192` | ESP8266 LittleFS block size |
| `ESP8266_LITTLEFS_BLOCK_SIZE_CANDIDATES` | `[8192, 4096]` | ESP8266 block size candidates |
| `ESP8266_LITTLEFS_PAGE_SIZE` | `256` | ESP8266 LittleFS page size |
| `ESP8266_SPIFFS_PAGE_SIZE` | `256` | ESP8266 SPIFFS page size |
| `ESP8266_SPIFFS_BLOCK_SIZE` | `8192` | ESP8266 SPIFFS block size |

---

## Type Definitions

### `Logger` Interface

```typescript
interface Logger {
  log(msg: string, ...args: any[]): void;
  error(msg: string, ...args: any[]): void;
  debug(msg: string, ...args: any[]): void;
}
```

---

## Complete Example

```typescript
import {
  connect,
  parsePartitionTable,
  detectFilesystemFromImage,
  formatSize,
  formatMacAddr,
} from "esp32tool";

const logger = {
  log: (msg) => console.log(`[ESP] ${msg}`),
  error: (msg) => console.error(`[ESP] ${msg}`),
  debug: () => {},
};

// 1. Connect and initialize
const esploader = await connect(logger);
await esploader.initialize();
console.log(`Chip: ${esploader.chipName}, Rev: ${esploader.chipRevision}`);

// 2. Get MAC address
const mac = await esploader.getMacAddress();
console.log(`MAC: ${mac}`);

// 3. Load stub for flash operations
const stub = await esploader.runStub();
console.log(`Flash: ${stub.flashSize}`);

// 4. Change baudrate for faster operations
await stub.setBaudrate(921600);

// 5. Read partition table
const partData = await stub.readFlash(0x8000, 0xC00);
const partitions = parsePartitionTable(partData);
for (const p of partitions) {
  console.log(`  ${p.name}: ${p.typeName}/${p.subtypeName}, offset=0x${p.offset.toString(16)}, size=${formatSize(p.size)}`);
}

// 6. Backup flash
const backup = await stub.readFlash(0x0, 0x400000, (pkt, progress, total) => {
  console.log(`Reading: ${((progress / total) * 100).toFixed(1)}%`);
});

// 7. Write firmware
const firmware = await fetch("firmware.bin").then((r) => r.arrayBuffer());
await stub.flashData(firmware, (written, total) => {
  console.log(`Writing: ${((written / total) * 100).toFixed(1)}%`);
}, 0x10000, true);

// 8. Reset to firmware
await stub.hardReset();

// 9. Disconnect
await esploader.disconnect();
```
