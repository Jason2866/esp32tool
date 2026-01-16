# ESP32Tool CLI

Command-line interface for flashing ESP devices, providing esptool.py-like functionality.

## Two Versions Available

### 1. Standalone Electron CLI (Recommended)

**Fully standalone - No Node.js installation required!**

- Download from GitHub Releases
- ~114MB per platform
- Includes everything needed to run
- Available as DMG (macOS), ZIP (all platforms)

**Installation & Usage:**

**macOS:**
```bash
# Option 1: Install to Applications (recommended)
# Open the DMG and drag ESP32Tool.app to /Applications
# Then run from terminal:
/Applications/ESP32Tool.app/Contents/MacOS/esp32tool list-ports
/Applications/ESP32Tool.app/Contents/MacOS/esp32tool --port /dev/ttyUSB0 chip-id

# Option 2: Create a symlink for easier access
sudo ln -s /Applications/ESP32Tool.app/Contents/MacOS/esp32tool /usr/local/bin/esp32tool
# Then simply use:
esp32tool list-ports
esp32tool --port /dev/ttyUSB0 chip-id

# Option 3: Extract ZIP and run directly
unzip ESP32Tool-CLI-*.zip
./ESP32Tool.app/Contents/MacOS/esp32tool list-ports
```

**Linux:**
```bash
# Extract ZIP
unzip ESP32Tool-CLI-*.zip
cd ESP32Tool-linux-*/

# Run the executable
./esp32tool list-ports
./esp32tool --port /dev/ttyUSB0 chip-id

# Optional: Create symlink for system-wide access
sudo ln -s $(pwd)/esp32tool /usr/local/bin/esp32tool
```

**Windows:**
```bash
# Extract ZIP
# Navigate to extracted folder
# Run from Command Prompt or PowerShell:
esp32tool.exe list-ports
esp32tool.exe --port COM3 chip-id

# Optional: Add to PATH for system-wide access
# Add the extracted folder to your system PATH environment variable
```

### 2. Node.js CLI (For Developers)

**Requires Node.js 22.12.0 or higher**

For development or if you prefer a smaller footprint and already have Node.js installed.

## Installation (Node.js Version)

### Prerequisites

1. Node.js >= 22.12.0

```bash
npm install
```

### Build

```bash
npm run build
```

### Global Installation (Optional)

```bash
npm link
```

After linking, you can use `esp32tool` command globally.

### Implemented Commands

- `list-ports` - List available serial ports
- `chip-id` - Read chip information (family, name, revision, variant)
- `flash-id` - Read flash size
- `read-mac` - Read MAC address from efuses
- `read-flash` - Read flash memory to file
- `write-flash` - Write file to flash memory
- `erase-flash` - Erase entire flash chip
- `erase-region` - Erase a specific region of flash
- `verify-flash` - Verify flash contents against file

### Implementation Details

The CLI uses the same core ESP loader implementation as the web interface, ensuring consistent behavior across platforms. Key features:

- **MAC Address**: Read directly from efuses (already loaded during chip initialization)
- **Flash Operations**: Use the stub loader for optimal performance
- **Write Flash**: Supports progress reporting during write operations
- **Erase Operations**: Both full chip erase and region-specific erase supported
- **Error Handling**: Comprehensive error messages and retry logic

## Usage

### Standalone Electron CLI

```bash
# macOS
/path/to/esp32tool [options] <command> [args...]

# Linux
./esp32tool [options] <command> [args...]

# Windows
esp32tool.exe [options] <command> [args...]
```

### Node.js CLI

```bash
esp32tool [options] <command> [args...]
# or if not globally installed:
node dist/cli-fixed.js [options] <command> [args...]
```

### Options

- `--port, -p <port>` - Serial port path (e.g., `/dev/ttyUSB0`, `COM3`)
- `--baud, -b <rate>` - Baud rate (default: 115200)
  - For faster operations, use higher rates: 460800, 921600, or 2000000
  - The stub loader will use this rate for all operations
- `--help, -h` - Show help message

### Commands

#### List Available Ports

```bash
esp32tool list-ports
```

Lists all available serial ports on your system.

#### Read Chip Information

```bash
esp32tool --port /dev/ttyUSB0 chip-id
```

Displays chip family, name, and revision.

#### Read Flash ID

```bash
esp32tool --port /dev/ttyUSB0 flash-id
```

Reads SPI flash manufacturer and device ID, and detects flash size.

#### Read MAC Address

```bash
esp32tool --port /dev/ttyUSB0 read-mac
```

Reads the device's MAC address.

#### Read Flash Memory

```bash
esp32tool --port /dev/ttyUSB0 read-flash 0x0 0x400000 flash_dump.bin
```

Reads flash memory from specified offset and size, saves to file.

- `offset` - Start address in hex (e.g., `0x0`)
- `size` - Number of bytes to read in hex (e.g., `0x400000` = 4MB)
- `filename` - Output file path

#### Write Flash Memory

```bash
esp32tool --port /dev/ttyUSB0 write-flash 0x1000 bootloader.bin
```

Writes a binary file to flash at specified offset.

- `offset` - Start address in hex (e.g., `0x1000`)
- `filename` - Input file path

#### Erase Entire Flash

```bash
esp32tool --port /dev/ttyUSB0 erase-flash
```

Erases the entire flash chip. **Warning: This will erase all data!**

#### Erase Flash Region

```bash
esp32tool --port /dev/ttyUSB0 erase-region 0x9000 0x6000
```

Erases a specific region of flash.

- `offset` - Start address in hex
- `size` - Number of bytes to erase in hex

#### Verify Flash Contents

```bash
esp32tool --port /dev/ttyUSB0 verify-flash 0x1000 bootloader.bin
```

Verifies that flash contents match a file.

- `offset` - Start address in hex
- `filename` - File to compare against

## Examples

### Complete Flash Workflow

```bash
# 1. List available ports
esp32tool list-ports

# 2. Check chip info
esp32tool --port /dev/ttyUSB0 chip-id

# 3. Backup current flash
esp32tool --port /dev/ttyUSB0 read-flash 0x0 0x400000 backup.bin

# 4. Erase flash
esp32tool --port /dev/ttyUSB0 erase-flash

# 5. Write new firmware
esp32tool --port /dev/ttyUSB0 write-flash 0x0 bootloader.bin
esp32tool --port /dev/ttyUSB0 write-flash 0x8000 partitions.bin
esp32tool --port /dev/ttyUSB0 write-flash 0x10000 firmware.bin

# 6. Verify
esp32tool --port /dev/ttyUSB0 verify-flash 0x10000 firmware.bin
```

### High-Speed Flashing

For faster read/write operations, use a higher baud rate:

```bash
# Fast read (921600 baud)
esp32tool --port /dev/ttyUSB0 --baud 921600 read-flash 0x0 0x400000 backup.bin

# Very fast write (2Mbps) - if your USB-Serial adapter supports it
esp32tool --port /dev/ttyUSB0 --baud 2000000 write-flash 0x10000 firmware.bin

# Standard speed (115200 baud) - most compatible
esp32tool --port /dev/ttyUSB0 write-flash 0x10000 firmware.bin
```

**Supported Baud Rates:**
- 115200 (default, most compatible)
- 230400
- 460800
- 921600 (recommended for most USB-Serial adapters)
- 2000000 (2Mbps, for high-speed adapters like CP2102N, CH343)

**Note:** Higher baud rates require a good quality USB cable and compatible USB-Serial adapter.

### Debug Mode

```bash
DEBUG=1 esp32tool --port /dev/ttyUSB0 chip-id
```

## Platform-Specific Notes

### Linux

- Ports are typically `/dev/ttyUSB0`, `/dev/ttyACM0`, etc.
- You may need to add your user to the `dialout` group:
  ```bash
  sudo usermod -a -G dialout $USER
  ```
- Log out and back in for changes to take effect

### macOS

- Ports are typically `/dev/cu.usbserial-*` or `/dev/cu.SLAB_USBtoUART`
- No special permissions needed

### Windows

- Ports are `COM1`, `COM3`, etc.
- Check Device Manager to find the correct port
- May need to install CH340/CP2102 drivers

## Comparison with esptool.py

This CLI provides similar functionality to esptool.py:

| esptool.py | esp32tool CLI |
|------------|---------------|
| `esptool.py chip-id` | `esp32tool chip-id` |
| `esptool.py flash-id` | `esp32tool flash-id` |
| `esptool.py read-mac` | `esp32tool read-mac` |
| `esptool.py read-flash` | `esp32tool read-flash` |
| `esptool.py write-flash` | `esp32tool write-flash` |
| `esptool.py erase-flash` | `esp32tool erase-flash` |
| `esptool.py erase-region` | `esp32tool erase-region` |

**Key Differences:**
- **esptool.py**: Requires Python installation
- **esp32tool (Electron)**: Fully standalone, no dependencies
- **esp32tool (Node.js)**: Requires Node.js installation

## Troubleshooting

### "No serial ports found"

- Check that your ESP device is connected
- Check USB cable (some cables are power-only)
- Install appropriate USB-to-Serial drivers (CH340, CP2102, etc.)

### "Permission denied" (Linux)

```bash
sudo usermod -a -G dialout $USER
# Log out and back in
```

### Connection Timeout

- Try holding the BOOT button while connecting
- Try a lower baud rate: `--baud 115200`
- Check that no other program is using the port

## Development

### Building Standalone Electron CLI

```bash
npm run build:cli-electron
```

Output: `out-cli/make/`

### Building Node.js CLI

```bash
npm run build
```

Output: `dist/cli-fixed.js`

### Project Structure

```
src/
├── cli.ts                  # CLI entry point (shared by both versions)
├── node-serial-adapter.ts  # SerialPort adapter for Node.js
├── esp_loader.ts           # Core ESP loader (shared with web)
└── ...
electron/
├── main.cjs                # GUI app entry point
└── cli-main.cjs            # CLI app entry point (Electron-based)
```

### Testing

```bash
# Test Node.js CLI locally
node dist/cli-fixed.js list-ports
node dist/cli-fixed.js --port /dev/ttyUSB0 chip-id

# Test Electron CLI locally
npm run build:cli-electron
out-cli/esp32tool-cli.app/Contents/MacOS/esp32tool list-ports
```
