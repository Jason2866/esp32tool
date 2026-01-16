

# 🚀 ESP32Tool – The Ultimate ESP Filesystem Powerhouse

**Flash. Manage. Dominate. In your browser, on desktop, mobile, or command line.**

Meet **ESP32Tool** – your all-in-one, next-gen solution for ESP device management. Experience seamless firmware flashing, backup, and now, full filesystem control with just a few clicks. No drivers, no command line hassle, no limits!

---

## 📦 Available Versions

**Choose the version that fits your workflow:**

### 🌐 Web App (Browser)
- **Zero installation** – runs directly in your browser
- Works on any modern desktop or mobile browser
- Perfect for quick tasks and on-the-go management
- **Try it now:** [jason2866.github.io/esp32tool](https://jason2866.github.io/esp32tool)

### 📱 Mobile App (Android PWA)
- **Install as native app** on Android devices
- Works with USB OTG adapters via WebUSB
- Full ESP management on your phone or tablet
- **Install:** Visit [jason2866.github.io/esp32tool](https://jason2866.github.io/esp32tool) in Chrome → "Add to Home screen"
- **Details:** See [Android Installation](#-android-installation-pwa) below

### 💻 Desktop App (Electron GUI)
- **Full-featured GUI** with all web capabilities
- Offline-ready, no internet required
- Native desktop integration
- **Download:** [Latest Release](https://github.com/Jason2866/esp32tool/releases)
- Available for: macOS (Intel & Apple Silicon), Windows, Linux

### ⌨️ Command Line Interface (CLI)
- **Standalone executable** – no Node.js required!
- Perfect for automation and scripting
- esptool.py-compatible commands
- **Download:** [Latest Release](https://github.com/Jason2866/esp32tool/releases)
- **Documentation:** [CLI-README.md](CLI-README.md)
- Available for: macOS (Intel & Apple Silicon), Windows, Linux

---

✨ **What makes ESP32Tool shine?**

**ESP32 First!**
ESP32Tool is designed first and foremost for the entire ESP32 family – delivering the most advanced, seamless, and powerful filesystem and firmware management for all ESP32 variants. Every feature and update is optimized for ESP32 users.

- **Universal Filesystem Support:** Instantly detect, read, and write to LittleFS, SPIFFS, and FATFS – all major ESP filesystems, fully supported!
- **Total File Control:** Effortlessly add or delete individual files. Upload, download, organize – your ESP, your rules.
- **Lightning Fast:** Custom, high-performance flash access – up to 10x faster than esptool.py!
- **Rock-Solid Reliability:** Automatic resume on read errors. No more broken operations, ever.
- **Plug & Play:** Manage your ESP directly in the browser. No software installation needed.
- **Multi-Platform:** Available as web app, desktop app (Electron), and standalone CLI
- **Offline Ready:** Desktop and CLI versions work completely offline
- **📱 Android Ready:** Install as Progressive Web App (PWA) on Android! Works with USB OTG adapters via WebUSB.

- **Bonus:** ESP8266 support is now included! Manage filesystems on ESP8266 devices with the same ease.

> **Try it now:** [jason2866.github.io/esp32tool](https://jason2866.github.io/esp32tool)

---

## 📦 Desktop & CLI Installation

### Desktop App (GUI)

**Download from [GitHub Releases](https://github.com/Jason2866/esp32tool/releases)**

- **macOS:** Download `ESP32Tool-*.dmg`, open and drag to Applications
- **Windows:** Download and run `ESP32Tool-Setup-*.exe` installer
- **Linux:** Download `.deb` (Debian/Ubuntu) or `.rpm` (Fedora/RHEL) package

### Command Line Interface

**Download from [GitHub Releases](https://github.com/Jason2866/esp32tool/releases)**

Look for `ESP32Tool-CLI-*` files. No Node.js installation required!

**Quick Start:**
```bash
# macOS
/Applications/ESP32Tool.app/Contents/MacOS/esp32tool list-ports
/Applications/ESP32Tool.app/Contents/MacOS/esp32tool --port /dev/ttyUSB0 chip-id

# Linux
./esp32tool list-ports
./esp32tool --port /dev/ttyUSB0 chip-id

# Windows
esp32tool.exe list-ports
esp32tool.exe --port COM3 chip-id
```

**Full CLI documentation:** [CLI-README.md](CLI-README.md)

---

## 📱 Android Installation (PWA)

ESP32Tool works natively on Android devices with USB OTG support!

**Requirements:**
- Android 5.0+ (Lollipop or higher)
- Chrome for Android 61+ (recommended: latest version)
- USB OTG adapter/cable
- ESP32/ESP8266 device

**Installation:**
1. Open [jason2866.github.io/esp32tool](https://jason2866.github.io/esp32tool) in Chrome
2. Tap the menu (⋮) → "Add to Home screen" or "Install app"
3. Connect your ESP device via USB OTG adapter
4. Grant USB permissions when prompted
5. Flash and manage your ESP devices on the go!

---

## 🛠️ Developer Quickstart

1. Clone this repository
2. Install dependencies: `npm install`
3. Start the dev environment: `script/develop`
4. Open [http://localhost:5004/](http://localhost:5004/) in your browser

---

## 🏆 The Story

Born from the minds of [Melissa LeBlanc-Williams](https://github.com/makermelissa), Adafruit, Nabu Casa and now supercharged by Jason2866, ESP32Tool has evolved into the most advanced, browser-based ESP management suite. With every update, the boundaries are pushed of what’s possible for your ESP devices.

**Latest updates:**

December 2025 – Now with full LittleFS, SPIFFS, and FATFS support, plus file add/delete magic! Available as web app and desktop GUI.

January 2026 – Added Android mobile devices support, standalone CLI.

---

© Adafruit, Nabu Casa & Johann Obermeier
