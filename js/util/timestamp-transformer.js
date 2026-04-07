// Matches lines that already carry a wall-clock or tick timestamp so we don't
// add a redundant one.  Intentionally does NOT match bare log-level prefixes
// like ESPHome's [I][tag:line]: — those have no time information.
//
// Covered formats:
//   (123456)          FreeRTOS ms-tick  e.g. "(12345) "
//   [HH:MM:SS]        wall-clock bracket
//   [HH:MM:SS.mmm]    wall-clock bracket with millis
//   I (1234) tag:     ESP-IDF log level + tick  e.g. "I (1234) wifi: ..."
//   HH:MM:SS.mmm      plain wall-clock
const DEVICE_TIMESTAMP_RE = /^\s*(?:\(\d+\)\s|\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]|[DIWEACV] \(\d+\) \w|(?:\d{2}:){2}\d{2}\.\d)/;
export class TimestampTransformer {
    constructor() {
        this.deviceHasTimestamps = false;
    }
    transform(chunk, controller) {
        // Pass through pure newline / empty sentinel unchanged so that
        // carriage-return overwrite logic in console-color.ts still works.
        if (chunk === "" || chunk === "\n" || chunk === "\r") {
            controller.enqueue(chunk);
            return;
        }
        if (!this.deviceHasTimestamps && DEVICE_TIMESTAMP_RE.test(chunk)) {
            this.deviceHasTimestamps = true;
        }
        if (this.deviceHasTimestamps) {
            controller.enqueue(chunk);
            return;
        }
        const date = new Date();
        const h = date.getHours().toString().padStart(2, "0");
        const m = date.getMinutes().toString().padStart(2, "0");
        const s = date.getSeconds().toString().padStart(2, "0");
        controller.enqueue(`[${h}:${m}:${s}] ${chunk}`);
    }
    reset() {
        this.deviceHasTimestamps = false;
    }
}
