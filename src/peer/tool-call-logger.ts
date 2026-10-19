/**
 * pi extension appending one line per completed tool call to tool-calls.jsonl
 * (spec 14.6), plus a tool span per invocation when a peer trace state is wired.
 * The JSONL writer is unchanged; spans are additive.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConversationLog } from "../logging/conversation-log";
import type { PeerTraceState } from "../tracing/peer-trace";
import type { SpanHandle } from "../tracing/tracing";

interface StartedTool {
  startedAt: number;
  args: unknown;
  span?: SpanHandle;
}

export function toolCallLogger(
  agentId: string,
  log: ConversationLog,
  trace?: PeerTraceState,
): (pi: ExtensionAPI) => void {
  const starts = new Map<string, StartedTool>();
  return (pi) => {
    pi.on("tool_execution_start", (event) => {
      // `toolCallId` is the SDK's per-invocation id: the tool span's operation_id.
      const span = trace?.startTool(event.toolCallId, event.toolName, agentId);
      starts.set(event.toolCallId, {
        startedAt: Date.now(),
        args: event.args,
        ...(span ? { span } : {}),
      });
    });
    pi.on("tool_execution_end", (event) => {
      const started = starts.get(event.toolCallId);
      starts.delete(event.toolCallId);
      if (started?.span) trace?.endTool(started.span, event.isError ? "error" : "ok");
      // A start-less call (extension attached late, or across sessions) still
      // logs, without args/durationMs (JSON.stringify drops undefined keys) —
      // the row must exist either way.
      const entry: Record<string, unknown> = {
        timestamp: Date.now(),
        agentId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: started?.args,
        isError: event.isError,
        durationMs: started !== undefined ? Date.now() - started.startedAt : undefined,
      };
      void log.append(entry).catch(() => {});
    });
  };
}
