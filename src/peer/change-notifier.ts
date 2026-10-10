/**
 * Peer-side change signal (P1-1): emit `INTENT_TO_MODIFY` once when a
 * file-mutating tool succeeds, so the runtime arms the validation gate. Failed
 * mutations and read-only tools (read/bash/grep) do not count, and one signal is
 * enough — the runtime's ChangeDetector only tracks a boolean.
 *
 * Args live on `tool_execution_start`, not `tool_execution_end`, so the path is
 * captured at start and reported at end (as with the tool-call logger).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { A2AEnvelope } from "../contracts/a2a-schema";

const MUTATING_TOOLS = new Set(["edit", "write"]);

export function changeNotifier(
  agentId: string,
  send: (env: A2AEnvelope) => void,
): (pi: ExtensionAPI) => void {
  let sent = false;
  const pending = new Map<string, { toolName: string; filePath: string }>();
  return (pi) => {
    pi.on("tool_execution_start", (event) => {
      if (!MUTATING_TOOLS.has(event.toolName)) return;
      const filePath = (event.args as { path?: string } | undefined)?.path ?? "<unknown>";
      pending.set(event.toolCallId, { toolName: event.toolName, filePath });
    });
    pi.on("tool_execution_end", (event) => {
      const info = pending.get(event.toolCallId);
      pending.delete(event.toolCallId);
      if (sent || event.isError || info === undefined) return;
      sent = true;
      send({
        id: `mut-${agentId}-${Date.now()}`,
        timestamp: Date.now(),
        sender: agentId,
        recipient: "supervisor",
        type: "INTENT_TO_MODIFY",
        payload: { agentId, filePath: info.filePath, intent: info.toolName },
      });
    });
  };
}
