/**
 * Peer-side protocol handling: run a work order (retrying empty/errored turns)
 * and reply to prompts, plus the inbound bus line dispatch. Kept SDK-free so it
 * stays unit-testable.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";
import { parseCriteriaBlock } from "../contracts/criteria";

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

const needsRetry = (result: SessionResult): boolean =>
  !result.report.trim() || result.stopReason === "error";

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
    result = await deps.runSession(
      `${action}\n\nYour previous response was empty or errored (${result.errorMessage ?? result.stopReason ?? "unknown"}). Produce your full report now.`,
    );
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

export interface InboundDeps {
  agentId: string;
  runTurn: (prompt: string) => Promise<SessionResult>;
  send: (env: A2AEnvelope) => void;
  stop: () => void;
  onDone: (result: SessionResult) => void;
  onError: (err: unknown) => void;
  retry?: RetryPolicy;
  now?: () => number;
}

/**
 * Parse one inbound bus line and act on it: a stop signal, a WORK_ORDER, or a
 * PROMPT. Returns false when the caller must stop reading (a stop signal was
 * received); blank, malformed, and unrelated lines are ignored and return true.
 */
export function handleInboundLine(line: string, deps: InboundDeps): boolean {
  if (!line.trim()) return true;
  let env: A2AEnvelope;
  try {
    env = JSON.parse(line) as A2AEnvelope;
  } catch {
    return true;
  }
  if (isStopSignal(env, deps.agentId)) {
    deps.stop();
    return false;
  }
  const now = deps.now ?? Date.now;
  if (env.type === "WORK_ORDER") {
    const action = (env.payload as { action: string }).action;
    void handleWorkOrder(
      deps.agentId,
      action,
      { runSession: deps.runTurn, send: deps.send, now },
      deps.retry,
    )
      .then(deps.onDone)
      .catch(deps.onError);
  } else if (env.type === "PROMPT") {
    const text = (env.payload as { text: string }).text;
    const correlationId = env.correlationId;
    void deps
      .runTurn(text)
      .then((result) => {
        // A reviewer reply carrying a fenced JSON verdict block ships as
        // structured criteria; the supervisor's prose cannot substitute for it.
        const criteria = parseCriteriaBlock(result.report);
        deps.send({
          id: `resp-${deps.agentId}-${now()}`,
          correlationId,
          timestamp: now(),
          sender: deps.agentId,
          recipient: env.sender,
          type: "RESPONSE",
          payload: {
            agentId: deps.agentId,
            text: result.report,
            usage: result.usage,
            ...(criteria ? { criteria } : {}),
          },
        });
        deps.onDone(result);
      })
      .catch(deps.onError);
  }
  return true;
}
