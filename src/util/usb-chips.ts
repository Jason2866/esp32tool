/// <reference types="@types/w3c-web-serial" />

export interface USBSerialChipInfo {
  name: string;
  maxBaudrate?: number;
}

// Common USB-Serial chip vendors and their products
export const USB_SERIAL_CHIPS: Record<
  number,
  Record<number, USBSerialChipInfo>
> = {
  0x1a86: {
    // QinHeng Electronics
    0x7522: { name: "CH340", maxBaudrate: 460800 },
    0x7523: { name: "CH340", maxBaudrate: 460800 },
    0x7584: { name: "CH340", maxBaudrate: 460800 },
    0x5523: { name: "CH341", maxBaudrate: 2000000 },
    0x55d3: { name: "CH343", maxBaudrate: 6000000 },
    0x55d4: { name: "CH9102", maxBaudrate: 6000000 },
    0x55d8: { name: "CH9101", maxBaudrate: 3000000 },
  },
  0x10c4: {
    // Silicon Labs
    0xea60: { name: "CP2102(n)", maxBaudrate: 3000000 },
    0xea70: { name: "CP2105", maxBaudrate: 2000000 },
    0xea71: { name: "CP2108", maxBaudrate: 2000000 },
  },
  0x0403: {
    // FTDI
    0x6001: { name: "FT232R", maxBaudrate: 3000000 },
    0x6010: { name: "FT2232", maxBaudrate: 3000000 },
    0x6011: { name: "FT4232", maxBaudrate: 3000000 },
    0x6014: { name: "FT232H", maxBaudrate: 12000000 },
    0x6015: { name: "FT230X", maxBaudrate: 3000000 },
  },
  0x067b: {
    // Prolific
    0x2303: { name: "PL2303", maxBaudrate: 6000000 },
  },
  0x303a: {
    // Espressif (native USB)
    0x2: { name: "ESP32-S2 Native USB", maxBaudrate: 2000000 },
    0x12: { name: "ESP32-P4 Native USB", maxBaudrate: 2000000 },
    0x1001: { name: "ESP32 Native USB", maxBaudrate: 2000000 },
  },
};

// Known USB-Serial vendor IDs derived from USB_SERIAL_CHIPS
export const knownVendorIds: number[] =
  Object.keys(USB_SERIAL_CHIPS).map(Number);

// Web Serial port filters (hiding non-ESP ports like Bluetooth)
export const serialPortFilters: SerialPortFilter[] = knownVendorIds.map(
  (id) => ({
    usbVendorId: id,
  }),
);

// WebUSB device filters
export const webUSBDeviceFilters: { vendorId: number }[] = knownVendorIds.map(
  (id) => ({
    vendorId: id,
  }),
);
