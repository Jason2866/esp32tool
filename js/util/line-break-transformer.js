export class LineBreakTransformer {
  constructor() {
    this.chunks = "";
  }

  transform(chunk, controller) {
    // Append new chunks to existing chunks.
    this.chunks += chunk;
    // Split on \r\n, lone \r, or lone \n — capturing the separator so we can
    // distinguish a lone \r (overwrite intent) from a normal newline.
    const re = /\r\n|\r|\n/g;
    let lastIndex = 0;
    let match;
    while ((match = re.exec(this.chunks)) !== null) {
      // If this is a lone \r at the very end of the buffer, leave it so it can
      // be combined with a possible following \n in the next chunk.
      if (match[0] === "\r" && match.index === this.chunks.length - 1) {
        break;
      }
      const line = this.chunks.substring(lastIndex, match.index);
      // Emit with \r suffix only for lone \r (overwrite), \n for everything else.
      const suffix = match[0] === "\r" ? "\r" : "\n";
      controller.enqueue(line + suffix);
      lastIndex = re.lastIndex;
    }
    this.chunks = this.chunks.substring(lastIndex);
  }

  flush(controller) {
    // When the stream is closed, flush any remaining chunks out.
    controller.enqueue(this.chunks);
  }
}
