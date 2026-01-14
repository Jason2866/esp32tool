# WebUSB on Android - Implementation Notes

## 🐛 Known Issues & Solutions

### 1. Stub Loader 0xC0 Flush Bug

**Problem:**
- Original stub loaders flush USB buffer on every 0xC0 byte
- This causes 3 USB bulk transfers instead of 1 for each response
- WebUSB can lose transfers if not queued fast enough

**Solution:**
✅ **FIXED** - Using patched stub loaders that only flush on frame end

### 2. USB Bulk Transfer Size

**Problem:**
- Large transfers (64KB) can cause data loss on Android
- Small buffer (64 bytes) with USB serial chips

**Solution:**
✅ Using different settings for CDC and serial USB chips

## 🔧 Current Implementation Status, done ✅

### ✅ Working:
- CDC/JTAG (ESP32-S2, S3, C3, C5, C6, H2) - Native USB
- Baudrate changes
- Flash reading/writing
- Stream management
- USB-Serial chips (CP2102, CH340, FTDI)

### ❌ Known Limitations:
- iOS not supported (no WebUSB)
- Firefox not supported (no WebUSB)
- Some Android devices don't support USB OTG

## 📊 Tested Configurations

| Device | Chip | Android | Status |
|--------|------|---------|--------|
| ESP32-S2 | Native USB | ✅ | Works perfectly |
| ESP32-S3 | Native USB | ✅ | Works perfectly |
| ESP32-C3 | Native USB | ✅ | Works perfectly |
| ESP32-C5 | Native USB | ✅ | Works perfectly |
| ESP32-C6 | Native USB | ✅ | Works perfectly |
| ESP32-H2 | Native USB | ✅ | Works perfectly |
| ESP32-x | CH343 | ✅ | Works perfectly |
| ESP32-x | CH340 | ✅ | Works |
| ESP32-x | CP2102 | ✅ | Works |
| ESP32-x | FTDI | ? | not tested |

## 🎯 Recommendations

### For Best Experience:
1. **Use ESP32-S2/S3/C3/C5/C6/H2** with native USB (CDC/JTAG)
2. **Use patched stub loaders** (already included)
3. **Use known good quality USB cable**

### For USB-Serial Chips:
1. **Start with 460800 baud**
2. **Use short USB cable** (< 50cm)
3. **Try different USB OTG adapters**

### Not Planned:
- iOS support (WebUSB not available)
- Firefox support (WebUSB not available)

## 📚 References
- [WebUSB Specification](https://wicg.github.io/webusb/)
- [USB CDC Class](https://www.usb.org/document-library/class-definitions-communication-devices-12)
- [ESP-IDF USB Documentation](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/usb-serial-jtag-console.html)

## 🙏 Credits

- **g3gg0** for WebUSB research and stub loader patches
- **Espressif** for esptool.py and stub loaders
- **Adafruit/Nabu Casa** for original ESP32Tool

---

**Last Updated:** January 2026
