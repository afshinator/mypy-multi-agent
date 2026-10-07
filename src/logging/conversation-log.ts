/**
 * Append-only JSONL log backing conversation.jsonl and tool-calls.jsonl.
 */
import { appendFile } from "node:fs/promises";

/** Append-only JSONL orchestration log. One JSON object per line. */
export class ConversationLog {
  constructor(private readonly path: string) {}

  append(entry: Record<string, unknown>): Promise<void> {
    return appendFile(this.path, JSON.stringify(entry) + "\n");
  }
}
