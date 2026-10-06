import type { A2AEnvelope } from "../contracts/a2a-schema";

export interface PeerRunDeps {
  runSession: (prompt: string) => Promise<string>;
  send: (env: A2AEnvelope) => void;
  now: () => number;
}

/** Run a work order: execute the session, then report back to the supervisor. */
export async function handleWorkOrder(agentId: string, action: string, deps: PeerRunDeps): Promise<string> {
  const report = await deps.runSession(action);
  deps.send({
    id: `report-${agentId}-${deps.now()}`,
    timestamp: deps.now(),
    sender: agentId,
    recipient: "supervisor",
    type: "FINAL_REPORT",
    payload: { agentId, report },
  });
  return report;
}
