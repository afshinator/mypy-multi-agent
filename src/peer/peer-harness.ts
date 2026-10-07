/**
 * Peer-side work-order execution: run the prompt, then send FINAL_REPORT with
 * usage. Kept SDK-free so it stays unit-testable.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";

export interface SessionUsage {
  cost: number;
  tokens: number;
}

export interface SessionResult {
  report: string;
  usage?: SessionUsage;
}

export interface PeerRunDeps {
  runSession: (prompt: string) => Promise<SessionResult>;
  send: (env: A2AEnvelope) => void;
  now: () => number;
}

/** Run a work order: execute the session, then report back (with usage) to the supervisor. */
export async function handleWorkOrder(agentId: string, action: string, deps: PeerRunDeps): Promise<SessionResult> {
  const result = await deps.runSession(action);
  deps.send({
    id: `report-${agentId}-${deps.now()}`,
    timestamp: deps.now(),
    sender: agentId,
    recipient: "supervisor",
    type: "FINAL_REPORT",
    payload: { agentId, report: result.report, usage: result.usage },
  });
  return result;
}

/** True when an inbound envelope orders `agentId` to stop (STOP_AGENT targets it, or STOP_ALL/KILL_ALL). */
export function isStopSignal(env: A2AEnvelope, agentId: string): boolean {
  if (env.type === "STOP_ALL" || env.type === "KILL_ALL") return true;
  if (env.type === "STOP_AGENT") return (env.payload as { agentId: string }).agentId === agentId;
  return false;
}
