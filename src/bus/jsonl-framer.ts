/**
 * JSONL framing for the bus socket: raw chunks in, complete frames out.
 * Instantiated per connection in src/runtime/runtime.ts, which passes each frame
 * to src/bus/router.ts. Buffers partial frames; skips blank lines; tolerates CRLF.
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
}
