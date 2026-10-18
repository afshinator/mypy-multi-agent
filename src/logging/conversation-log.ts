/**
 * Append-only JSONL log backing conversation.jsonl and tool-calls.jsonl.
 */
import { appendFile, readFile } from "node:fs/promises";

export class ConversationLog {
  constructor(private readonly path: string) {}

  append(entry: Record<string, unknown>): Promise<void> {
    return appendFile(this.path, `${JSON.stringify(entry)}\n`);
  }
}

/**
 * Read a JSONL file into records: one JSON object per line, blank and malformed
 * lines skipped, a missing file read as empty. The single reader for every JSONL
 * artifact (issue #31) — callers validate fields; this only parses.
 */
export async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A malformed line is skipped; consumers judge what parsed.
    }
  }
  return out;
}
