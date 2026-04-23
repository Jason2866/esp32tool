// Matches lines that already carry a wall-clock timestamp so we don't add a
// redundant one.  Only real wall-clock formats are matched — tick-based
// formats like FreeRTOS "(12345)" or ESP-IDF "I (15) boot:" are NOT matched
// because they don't carry time-of-day information
// Covered formats:
//   [HH:MM:SS]        wall-clock bracket
//   [HH:MM:SS.mmm]    wall-clock bracket with millis
//   HH:MM:SS.mmm      plain wall-clock
const DEVICE_TIMESTAMP_RE =
  /^\s*(?:\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]|(?:\d{2}:){2}\d{2}\.\d)/;

export class TimestampTransformer implements Transformer<string, string> {
  private deviceHasTimestamps = false;

  transform(
    chunk: string,
    controller: TransformStreamDefaultController<string>,
  ) {
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
