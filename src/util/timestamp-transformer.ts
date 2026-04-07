export class TimestampTransformer implements Transformer<string, string> {
  transform(
    chunk: string,
    controller: TransformStreamDefaultController<string>,
  ) {
    // Pass through pure newline (blank-line sentinel) and empty chunks unchanged
    // so that carriage-return overwrite logic in console-color.ts can still
    // detect them via line !== "\n".
    if (chunk === "" || chunk === "\n") {
      controller.enqueue(chunk);
      return;
    }
    const date = new Date();
    const h = date.getHours().toString().padStart(2, "0");
    const m = date.getMinutes().toString().padStart(2, "0");
    const s = date.getSeconds().toString().padStart(2, "0");
    controller.enqueue(`[${h}:${m}:${s}]${chunk}`);
  }
}
