/**
 * Append-only JSONL log backing conversation.jsonl and tool-calls.jsonl.
 */
import { appendFile, readFile } from "node:fs/promises";

import { parseJsonl } from "../../shared/parse-jsonl";

export class ConversationLog {
  constructor(private readonly path: string) {}

  append(entry: Record<string, unknown>): Promise<void> {
    return appendFile(this.path, `${JSON.stringify(entry)}\n`);
  }
}

/**
 * Read a JSONL file into records: one JSON object per line, blank and malformed
 * lines skipped, a missing file read as empty. Thin wrapper around the pure
 * shared parseJsonl (issue #31) — callers validate fields; this only parses.
 */
export async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return parseJsonl(text);
}
