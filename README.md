# ESP32Tool

JavaScript package to read and write anything blazing fast on ESP devices via the browser using WebSerial.
For offline use Electron compiled binaries are available in release section!

The tool uses its own code to read and write to the esp flash. Reading ist up to 10x faster than esptool.py
The routines do support resume if errors occur. No more broken read flash attempts like in esptool.py 

## Local development

- Clone this repository.
- Install dependencies with `npm install`
- Run `script/develop`
- Open http://localhost:5004/

## Origin

This project was originally written by [Melissa LeBlanc-Williams](https://github.com/makermelissa). [Nabu Casa](https://www.nabucasa.com) ported the code over to TypeScript and in March 2022 took over maintenance from Adafruit. In July 2022, the Nabucasa stopped maintaining the project in favor of an official, but very early release of Espressif's [esptool-js](https://github.com/espressif/esptool-js/). Due to the instability of the tool, Adafruit updated their fork with Nabucasa's changes in November 2022 and took over maintenance once again. In December 2024, the tool was once again updated to use Espressif's esptool-js as the backend. Since Adafruit uses esptool.js which is still buggy, i decided to maintain my own version. In 12/2025 support for new MCUs and chip variant support for the different P4 revisions and flash read was added.

Copyright: Adafruit, Nabu Casa and Johann Obermeier
