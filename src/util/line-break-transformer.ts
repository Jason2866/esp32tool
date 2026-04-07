export class LineBreakTransformer implements Transformer<string, string> {
  private chunks = "";

  transform(
    chunk: string,
    controller: TransformStreamDefaultController<string>,
  ) {
    // Append new chunks to existing chunks.
    this.chunks += chunk;
    // Split on \r\n, lone \r, or lone \n — capturing the separator so we can
    // distinguish a lone \r (overwrite intent) from a normal newline.
    const re = /\r\n|\r|\n/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.chunks)) !== null) {
      const line = this.chunks.substring(lastIndex, match.index);
      // Emit with \r suffix only for lone \r (overwrite), \n for everything else.
      const suffix = match[0] === "\r" ? "\r" : "\n";
      controller.enqueue(line + suffix);
      lastIndex = re.lastIndex;
    }
    this.chunks = this.chunks.substring(lastIndex);
  }

  flush(controller: TransformStreamDefaultController<string>) {
    // When the stream is closed, flush any remaining chunks out.
    controller.enqueue(this.chunks);
  }
}
