/**
 * Peer-side protocol handling: run a work order (retrying empty/errored turns)
 * and reply to prompts, plus the inbound bus line dispatch. Kept SDK-free so it
 * stays unit-testable.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";
import { parseCriteriaBlock } from "../contracts/criteria";
import type { PeerTraceState } from "../tracing/peer-trace";

export interface SessionUsage {
  cost: number;
  tokens: number;
  /** Cache-read tokens within `tokens`; the budget bound excludes them (RT-1). */
  cacheReadTokens?: number;
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

/**
 * MT-2: the peer produced no text AND no metered usage — the "connected but
 * mute" signature (run 1's pi_core). An empty report with real usage is a
 * legitimate (if terse) turn and is not flagged.
 */
function isUnusable(result: SessionResult): boolean {
  if (result.report.trim() !== "") return false;
  const usage = result.usage;
  return usage === undefined || (usage.cost === 0 && usage.tokens === 0);
}

function unusableEnvelope(
  agentId: string,
  attempts: number,
  now: number,
  result: SessionResult,
): A2AEnvelope {
  // Why the turns failed, so the supervisor can choose restart vs reassign
  // without guessing; omitted when the SDK reported no cause.
  // `||`, not `??`: an empty errorMessage must not mask a non-stop stopReason.
  const error =
    result.errorMessage ||
    (result.stopReason && result.stopReason !== "stop" ? result.stopReason : undefined);
  return {
    id: `unusable-${agentId}-${now}`,
    timestamp: now,
    sender: agentId,
    recipient: "supervisor",
    type: "AGENT_UNUSABLE",
    payload: { agentId, reason: "empty model output", attempts, ...(error ? { error } : {}) },
  };
}

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
  if (isUnusable(result)) {
    deps.send(unusableEnvelope(agentId, retry.maxRetries + 1, deps.now(), result));
    return result;
  }
  // A work-order report can carry the reviewer's attestation block too; without
  // this the gate never sees an attestation delivered as a final report (RT-9 G2).
  const criteria = parseCriteriaBlock(result.report);
  deps.send({
    id: `report-${agentId}-${deps.now()}`,
    timestamp: deps.now(),
    sender: agentId,
    recipient: "supervisor",
    type: "FINAL_REPORT",
    payload: {
      agentId,
      report: result.report,
      usage: result.usage,
      ...(criteria ? { criteria } : {}),
    },
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
  /** Pause between conversational-turn retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Peer-side file-lock frames (LOCK_ACQUIRED / correlated ERROR), routed here. */
  onLockFrame?: (env: A2AEnvelope) => void;
  /** Mints/closes the peer.turn around WORK_ORDER/PROMPT handling. */
  trace?: PeerTraceState;
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
    deps.trace?.endTurn("aborted");
    deps.stop();
    return false;
  }
  if (env.type === "LOCK_ACQUIRED" || env.type === "ERROR") {
    deps.onLockFrame?.(env);
    return true;
  }
  const now = deps.now ?? Date.now;
  if (env.type === "WORK_ORDER") {
    const { action, taskId } = env.payload as { action: string; taskId: string };
    const turn = deps.trace?.startTurnFrom(env, taskId, deps.agentId) ?? null;
    void handleWorkOrder(
      deps.agentId,
      action,
      { runSession: deps.runTurn, send: deps.send, now },
      deps.retry,
    )
      .then((result) => {
        if (turn) deps.trace?.endTurn("ok");
        deps.onDone(result);
      })
      .catch((err: unknown) => {
        if (turn) deps.trace?.endTurn("error");
        deps.onError(err);
      });
  } else if (env.type === "PROMPT") {
    const promptText = (env.payload as { text: string }).text;
    const correlationId = env.correlationId;
    const turn =
      correlationId !== undefined
        ? (deps.trace?.startTurnFrom(env, correlationId, deps.agentId) ?? null)
        : null;
    void runPromptWithRetry(deps, promptText)
      .then(({ result, attempts }) => {
        if (turn) deps.trace?.endTurn("ok");
        // A reply that stays empty through retries is a non-delivery: escalate
        // like the work-order path rather than handing the supervisor an empty
        // RESPONSE that leads to a long blind await.
        if (!result.report.trim()) {
          deps.send(unusableEnvelope(deps.agentId, attempts, now(), result));
          deps.onDone(result);
          return;
        }
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
      .catch((err: unknown) => {
        if (turn) deps.trace?.endTurn("error");
        deps.onError(err);
      });
  }
  return true;
}

/**
 * Run a conversational turn, retrying while the reply is empty/whitespace (same
 * policy as work orders). A transient provider blip recovers here; a peer that
 * stays mute is escalated by the caller. Returns the last result and the number
 * of attempts, for the AGENT_UNUSABLE payload.
 */
async function runPromptWithRetry(
  deps: InboundDeps,
  text: string,
): Promise<{ result: SessionResult; attempts: number }> {
  const sleep = deps.sleep ?? defaultSleep;
  const retry = deps.retry ?? { maxRetries: 3, pauseMs: 30_000 };
  let result = await deps.runTurn(text);
  let attempts = 1;
  while (attempts <= retry.maxRetries && !result.report.trim()) {
    await sleep(retry.pauseMs);
    result = await deps.runTurn(
      `${text}\n\nYour previous response was empty. Reply again with your full answer.`,
    );
    attempts += 1;
  }
  return { result, attempts };
}
