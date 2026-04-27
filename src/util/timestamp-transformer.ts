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

// Matches leading ANSI SGR (color/style) codes at the start of a string
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
// eslint-disable-next-line no-control-regex
const LEADING_ANSI_RE = /^(\x1b\[(?:\d+;)*\d*m)+/;

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

    // Extract leading ANSI codes to preserve them across line splits
    const ansiMatch = chunk.match(LEADING_ANSI_RE);
    const leadingAnsi = ansiMatch ? ansiMatch[0] : "";
    const contentWithoutAnsi = leadingAnsi
      ? chunk.slice(leadingAnsi.length)
      : chunk;

    const date = new Date();
    const h = date.getHours().toString().padStart(2, "0");
    const m = date.getMinutes().toString().padStart(2, "0");
    const s = date.getSeconds().toString().padStart(2, "0");
    const timestamp = `[${h}:${m}:${s}]`;

    // For multi-line chunks, we need to preserve ANSI codes on each line
    // Split on newlines, but keep the newline characters
    const lines = contentWithoutAnsi.split(/(\r?\n)/);
    let result = "";
    let isFirstLine = true;

    for (let i = 0; i < lines.length; i++) {
      const part = lines[i];
      if (part === "\n" || part === "\r\n") {
        // Newline separator - just append it
        result += part;
        isFirstLine = false;
      } else if (part === "") {
        // Empty string from split, skip
        continue;
      } else {
        // Actual content line
        if (isFirstLine) {
          // First line: ANSI codes + timestamp + content
          result += leadingAnsi + timestamp + " " + part;
        } else {
          // Subsequent lines: ANSI codes + timestamp + content
          result += leadingAnsi + timestamp + " " + part;
        }
      }
    }

    controller.enqueue(result);
  }

  reset() {
    this.deviceHasTimestamps = false;
  }
}
