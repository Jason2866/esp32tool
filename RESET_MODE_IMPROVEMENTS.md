# Reset Mode Improvements

## Übersicht

Diese Änderungen verbessern die Reset-Logik für ESP32-Chips, insbesondere beim Wechsel vom Bootloader-Modus in den Firmware-Modus. Die Implementierung nutzt die `UARTDEV_BUF_NO_USB_OTG` und `UARTDEV_BUF_NO_USB_JTAG_SERIAL` Konstanten, um automatisch die richtige Reset-Methode zu wählen.

## Hauptänderungen

### 1. Neue Methode: `resetToFirmwareMode()`

Eine neue öffentliche Methode, die explizit den Wechsel vom Bootloader zum Firmware-Modus durchführt:

```typescript
public async resetToFirmwareMode(clearForceDownloadFlag = true): Promise<boolean>
```

**Funktionalität:**
- Erkennt automatisch den USB-Verbindungstyp (USB-JTAG/OTG vs. externer Serial-Chip)
- Wählt die passende Reset-Strategie:
  - **USB-JTAG/OTG**: Verwendet WDT-Reset (Watchdog Timer)
  - **Externer Serial-Chip**: Verwendet klassischen Hardware-Reset
- Behandelt Stub-zu-ROM-Übergang automatisch
- Löscht das "Force Download Boot" Flag bei USB-OTG-Geräten
- Gibt zurück, ob der Port sich ändern wird (wichtig für USB-OTG)

**Unterstützte Chips:**
- ESP32-S2 (USB-OTG)
- ESP32-S3 (USB-OTG + USB-JTAG/Serial)
- ESP32-C3 (USB-JTAG/Serial)
- ESP32-C5 (USB-JTAG/Serial)
- ESP32-C6 (USB-JTAG/Serial)
- ESP32-C61 (USB-JTAG/Serial)
- ESP32-H2 (USB-JTAG/Serial)
- ESP32-H4 (USB-JTAG/Serial)
- ESP32-P4 (USB-OTG + USB-JTAG/Serial)

### 2. Verbesserte `hardReset()` Methode

Die `hardReset(bootloader = false)` Methode wurde überarbeitet:

**Beim Reset zum Firmware-Modus (`bootloader = false`):**
- Verwendet `detectUsbConnectionType()` zur Erkennung des USB-Typs
- Ruft `getUsbMode()` auf, um detaillierte USB-Mode-Informationen zu erhalten
- Löscht automatisch das "Force Download Boot" Flag bei USB-OTG
- Verwendet WDT-Reset für USB-JTAG/OTG-Geräte
- Verwendet klassischen Reset für externe Serial-Chips

**Beim Reset zum Bootloader-Modus (`bootloader = true`):**
- Unverändert - verwendet die bisherige Logik

### 3. Vereinfachte `_resetToFirmwareIfNeeded()`

Diese interne Methode wurde vereinfacht und nutzt jetzt die neue `resetToFirmwareMode()`:

```typescript
private async _resetToFirmwareIfNeeded(): Promise<boolean>
```

- Delegiert die gesamte Reset-Logik an `resetToFirmwareMode()`
- Behandelt Port-Änderungen bei USB-OTG-Geräten
- Gibt Events aus, wenn Port-Reselection nötig ist

### 4. Neue Hilfsmethode: `supportsNativeUsb()`

```typescript
public supportsNativeUsb(): boolean
```

Prüft, ob der aktuelle Chip native USB-Unterstützung (JTAG oder OTG) hat.

### 5. Verbesserte `getUsbMode()` Logging

Die Methode verwendet jetzt `logger.debug()` statt `logger.log()` für weniger Ausgabe-Spam.

## Technische Details

### USB-Verbindungstyp-Erkennung

Die Erkennung erfolgt in zwei Schritten:

1. **PID-basierte Erkennung** (`detectUsbConnectionType()`):
   - Prüft USB Vendor ID (0x303a = Espressif)
   - Prüft USB Product ID (0x0002, 0x0012, 0x1001 = USB-JTAG/OTG)

2. **Register-basierte Erkennung** (`getUsbMode()`):
   - Liest das `UARTDEV_BUF_NO` Register
   - Vergleicht mit `UARTDEV_BUF_NO_USB_OTG` und `UARTDEV_BUF_NO_USB_JTAG_SERIAL`
   - Gibt detaillierten Modus zurück: "uart", "usb-jtag-serial", oder "usb-otg"

### Reset-Strategien

#### WDT-Reset (USB-JTAG/OTG)

Verwendet für Chips mit integriertem USB:

1. Unlock Watchdog-Register
2. Setze Timeout auf 2000ms
3. Enable Watchdog mit System-Reset
4. Lock Watchdog-Register
5. Warte auf automatischen Reset

**Warum WDT-Reset?**
- DTR/RTS-Signale sind bei USB-JTAG/OTG nicht verfügbar
- WDT-Reset stellt sicher, dass der Chip vollständig neu startet
- USB-Verbindung wird korrekt zurückgesetzt

#### Klassischer Reset (Externe Serial-Chips)

Verwendet für Chips mit externem USB-Serial-Adapter (CH340, CP2102, etc.):

1. Setze RTS=HIGH (EN=LOW) - Chip in Reset
2. Warte 100-200ms
3. Setze RTS=LOW (EN=HIGH) - Chip startet
4. IO0 bleibt HIGH - Boot in Firmware-Modus

### Force Download Boot Flag

Bei USB-OTG-Geräten (ESP32-S2, ESP32-S3, ESP32-P4):

- Das Flag wird im ROM gesetzt, wenn der Chip im Download-Modus startet
- Muss gelöscht werden, damit der Chip nach dem Reset in den Firmware-Modus bootet
- Wird automatisch von `resetToFirmwareMode()` behandelt

## Verwendungsbeispiele

### Beispiel 1: Expliziter Reset zum Firmware-Modus

```typescript
// Nach dem Flashen zurück zum Firmware-Modus
const portWillChange = await espLoader.resetToFirmwareMode();

if (portWillChange) {
  console.log("Port wird sich ändern - bitte neuen Port auswählen");
  // Warte auf Port-Reselection
} else {
  console.log("Gerät ist jetzt im Firmware-Modus");
}
```

### Beispiel 2: Reset in hardReset()

```typescript
// Reset zum Firmware-Modus (automatische Strategie-Wahl)
await espLoader.hardReset(false);

// Reset zum Bootloader-Modus
await espLoader.hardReset(true);
```

### Beispiel 3: USB-Typ prüfen

```typescript
if (espLoader.supportsNativeUsb()) {
  const usbMode = await espLoader.getUsbMode();
  console.log(`USB-Modus: ${usbMode.mode}`);
  
  if (usbMode.mode === "usb-otg") {
    console.log("USB-OTG erkannt - Port kann sich nach Reset ändern");
  }
}
```

## Vorteile

1. **Automatische Strategie-Wahl**: Kein manuelles Auswählen der Reset-Methode mehr nötig
2. **Zuverlässiger**: Verwendet die richtige Methode für jeden Chip-Typ
3. **Bessere Fehlerbehandlung**: Klare Fehlermeldungen und Logging
4. **Konsistente API**: Einheitliche Schnittstelle für alle Reset-Operationen
5. **Zukunftssicher**: Einfach erweiterbar für neue Chip-Familien

## Kompatibilität

- Vollständig rückwärtskompatibel mit bestehendem Code
- Bestehende `hardReset()` Aufrufe funktionieren weiterhin
- Neue `resetToFirmwareMode()` Methode ist optional

## Testing

Getestet mit:
- ESP32-S2 (USB-OTG)
- ESP32-S3 (USB-JTAG/Serial)
- ESP32-C3 (USB-JTAG/Serial)
- ESP32-C6 (USB-JTAG/Serial)
- ESP32 mit CH340 (externer Serial-Chip)

## Bekannte Einschränkungen

1. **Port-Änderung bei USB-OTG**: ESP32-S2 und ESP32-P4 mit USB-OTG ändern den Port nach WDT-Reset
2. **ESP32-H2**: Unterstützt keinen WDT-Reset (Hardware-Limitation)
3. **Stub-Modus**: Muss erst zu ROM zurückkehren, bevor Force Download Flag gelöscht werden kann
