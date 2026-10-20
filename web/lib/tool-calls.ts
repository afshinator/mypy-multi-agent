import { parseJsonl } from "../../shared/parse-jsonl";
import type { DirReader } from "./discovery";

export interface ToolCall {
  timestamp: number;
  agentId: string;
  toolName: string;
  /** Full JSON serialization of `args`, for truncate-and-expand display. */
  argsText: string;
  durationMs?: number;
  isError: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Build the typed tool-call table aggregate from tool-calls.jsonl text. */
export function buildToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const e of parseJsonl(text)) {
    const timestamp = num(e.timestamp);
    const agentId = str(e.agentId);
    const toolName = str(e.toolName);
    if (timestamp === undefined || agentId === undefined || toolName === undefined) continue;
    calls.push({
      timestamp,
      agentId,
      toolName,
      argsText: e.args === undefined ? "—" : JSON.stringify(e.args),
      durationMs: num(e.durationMs),
      isError: e.isError === true,
    });
  }
  return calls.sort((a, b) => a.timestamp - b.timestamp);
}

/** Load a task's tool-calls.jsonl through the reader; null when absent. */
export async function loadToolCalls(
  reader: DirReader,
  runDetailsPath: string,
): Promise<ToolCall[] | null> {
  const calls = await reader.readText(`${runDetailsPath}/tool-calls.jsonl`);
  return calls === null ? null : buildToolCalls(calls.text);
}
