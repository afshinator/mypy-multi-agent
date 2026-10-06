import { appendFile } from "node:fs/promises";

export interface ToolCallEntry {
  timestamp: number;
  agentId: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  isError?: boolean;
  durationMs?: number;
}

/** Append-only JSONL tool execution log (spec 14.6). One object per line. */
export class ToolCallLog {
  constructor(private readonly path: string) {}

  append(entry: ToolCallEntry): Promise<void> {
    return appendFile(this.path, JSON.stringify(entry) + "\n");
  }
}
