/**
 * Streams bytes in, emits complete JSONL frames (newline-delimited).
 * Buffers partial frames; skips blank lines; tolerates CRLF.
 */
export class JsonlFramer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const frames: string[] = [];
    for (;;) {
      const i = this.buffer.indexOf("\n");
      if (i === -1) break;
      let line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() !== "") frames.push(line);
    }
    return frames;
  }

  /** Return any unterminated partial frame (e.g. on disconnect), and clear it. */
  flush(): string | undefined {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() === "" ? undefined : rest;
  }
}
