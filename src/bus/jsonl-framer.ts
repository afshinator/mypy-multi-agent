/**
 * JSONL framing for the bus socket: raw chunks in, complete frames out. Sits
 * directly under src/bus/socket-server.ts and feeds src/bus/router.ts.
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

  /**
   * Return any unterminated partial frame (e.g. on disconnect), and clear it.
   * A lone trailing "\r" is treated as empty; the caller must not expect the
   * buffer to be newline-terminated.
   */
  flush(): string | undefined {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() === "" ? undefined : rest;
  }
}
