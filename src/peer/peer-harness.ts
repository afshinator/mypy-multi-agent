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
  /** Final assistant stop reason, when the SDK reported one. */
  stopReason?: string;
  errorMessage?: string;
}

export interface PeerRunDeps {
  runSession: (prompt: string) => Promise<SessionResult>;
  send: (env: A2AEnvelope) => void;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryPolicy {
  /** Attempts after the first try (0 = no retry). */
  maxRetries: number;
  /** Pause before each retry. */
  pauseMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const needsRetry = (result: SessionResult): boolean => !result.report.trim() || result.stopReason === "error";

/** Run a work order: execute the session, retrying empty/errored turns with a
 * pause, then report back (with usage) to the supervisor. */
export async function handleWorkOrder(
  agentId: string,
  action: string,
  deps: PeerRunDeps,
  retry: RetryPolicy = { maxRetries: 3, pauseMs: 30_000 },
): Promise<SessionResult> {
  const sleep = deps.sleep ?? defaultSleep;
  let result = await deps.runSession(action);
  for (let attempt = 0; attempt < retry.maxRetries && needsRetry(result); attempt++) {
    await sleep(retry.pauseMs);
    result = await deps.runSession(`${action}\n\nYour previous response was empty or errored (${result.errorMessage ?? result.stopReason ?? "unknown"}). Produce your full report now.`);
  }
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
