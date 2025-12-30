
# ESP32Tool

**ESP32Tool** is a JavaScript tool that lets you read and write data on ESP devices at lightning speed directly in your browser using WebSerial.

**Features:**
- Supports all common filesystems
- Upload and download files easily – no complicated steps
- Custom, high-performance flash access (up to 10x faster than esptool.py)
- Automatic resume on read errors – no more broken flash operations

👉 **Try ESP32Tool in your browser:** [jason2866.github.io/esp32tool](https://jason2866.github.io/esp32tool)

👉 **Offline use:** Electron binaries are available in the [release section](https://github.com/Jason2866/esp32tool/releases).

---

## Local Development

1. Clone this repository
2. Install dependencies: `npm install`
3. Start the development environment: `script/develop`
4. Open in your browser: [http://localhost:5004/](http://localhost:5004/)

---

## Origin & Development

This project was originally created by [Melissa LeBlanc-Williams](https://github.com/makermelissa). [Nabu Casa](https://www.nabucasa.com) ported the code to TypeScript and took over maintenance from Adafruit in March 2022. In July 2022, Nabu Casa stopped maintaining the project in favor of Espressif's [esptool-js](https://github.com/espressif/esptool-js). Due to instability, Adafruit updated their fork with Nabu Casa's changes in November 2022 and resumed maintenance. In December 2024, the backend was switched to Espressif's esptool-js. Since esptool.js remained buggy, this independent version was created. In December 2025, support for new MCUs, chip variants (P4 revisions), and optimized flash reading was added.

**Copyright:** Adafruit, Nabu Casa, and Johann Obermeier
