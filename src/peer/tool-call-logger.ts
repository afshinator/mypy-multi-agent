/**
 * pi extension appending one line per completed tool call to tool-calls.jsonl
 * (spec 14.6).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConversationLog } from "../logging/conversation-log";

export function toolCallLogger(agentId: string, log: ConversationLog): (pi: ExtensionAPI) => void {
  const starts = new Map<string, { startedAt: number; args: unknown }>();
  return (pi) => {
    pi.on("tool_execution_start", (event) => {
      starts.set(event.toolCallId, { startedAt: Date.now(), args: event.args });
    });
    pi.on("tool_execution_end", (event) => {
      const started = starts.get(event.toolCallId);
      starts.delete(event.toolCallId);
      const entry: Record<string, unknown> = {
        timestamp: Date.now(),
        agentId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: started?.args,
        isError: event.isError,
        durationMs: started !== undefined ? Date.now() - started.startedAt : undefined,
      };
      void log.append(entry);
    });
  };
}
