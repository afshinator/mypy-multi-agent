/**
 * One reusable peer session; serializes turns and captures accumulated usage,
 * the final stop reason, and assistant text per turn, streaming text deltas to
 * a callback. The SDK is reached only through PeerSessionHandle, which is what
 * keeps this module unit-testable with a fake.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionResult, SessionUsage } from "./peer-harness";

export interface PeerSessionHandle {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
  abort(): Promise<void>;
}

export interface PeerSessionDeps {
  createSession: () => Promise<PeerSessionHandle>;
  onTextDelta: (delta: string) => void;
}

/** Mutable per-turn accumulator the subscribe callback folds events into. */
interface TurnAcc {
  usage?: SessionUsage;
  stopReason?: string;
  errorMessage?: string;
}

type MessageEndEvent = Extract<AgentSessionEvent, { type: "message_end" }>;

/**
 * A5: events that show a turn is making progress. Anything else (agent_settled,
 * queue_update, session_info_changed, thinking_level_changed, summarization_*)
 * does not reset the stall clock.
 */
const PROGRESS_EVENTS = new Set<string>([
  "agent_start",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "compaction_start",
  "compaction_end",
  "bash_execution_update",
]);
// F2: `auto_retry_start`/`auto_retry_end` are deliberately NOT progress. They say a
// model call FAILED and is being attempted again — the opposite of forward motion.
// Counting them reset the stall clock for as long as a peer kept retrying, so a peer
// wedged by the very failures the agent-level retry exists to absorb could never be
// flagged (observed: two 420 s awaits with zero tool calls and no AGENT_STALLED).

/** A snapshot of turn activity for the heartbeat; consuming it resets the progress flag. */
export interface ProgressSnapshot {
  busy: boolean;
  progressed: boolean;
  /** The agent-level retry in flight, if any (RT-10). Absent when none is running. */
  retry?: { attempt: number; maxAttempts: number };
}

/** Fold one assistant `message_end` into the turn accumulator. A tool-loop turn
 * emits one message_end per request, each carrying only that request's cost;
 * accumulate or the turn undercounts against the peer's max_cost_usd. `usage`
 * stays undefined until the first event so "no usage reported" remains
 * distinguishable from a zero-cost turn. */
function absorbMessageEnd(e: MessageEndEvent, acc: TurnAcc): void {
  const m = e.message;
  if (m.role !== "assistant") return;
  if (m.usage) {
    const cacheReadTokens = (acc.usage?.cacheReadTokens ?? 0) + (m.usage.cacheRead ?? 0);
    acc.usage = {
      cost: (acc.usage?.cost ?? 0) + m.usage.cost.total,
      tokens: (acc.usage?.tokens ?? 0) + m.usage.totalTokens,
      // Omitted when zero so a cache-less provider keeps the plain {cost,tokens} shape.
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    };
  }
  if (m.stopReason !== undefined) {
    acc.stopReason = m.stopReason;
    acc.errorMessage = m.errorMessage;
  }
}

/**
 * Turns are serialized so an inbound message never interleaves with an
 * in-flight turn; the in-memory transcript persists across prompts, so the peer
 * keeps memory of its earlier work.
 */
export class PeerSession {
  private session: PeerSessionHandle | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = false;
  private progressed = false;
  /** RT-10: the retry in flight, cleared when it succeeds or the turn ends. */
  private retry: { attempt: number; maxAttempts: number } | undefined;

  constructor(private readonly deps: PeerSessionDeps) {}

  /** Whether a turn is open and whether progress occurred since the last call;
   * the progress flag is consumed here (one heartbeat sees each progress tick). */
  progressSnapshot(): ProgressSnapshot {
    const progressed = this.progressed;
    this.progressed = false;
    return { busy: this.busy, progressed, ...(this.retry ? { retry: this.retry } : {}) };
  }

  runTurn(prompt: string): Promise<SessionResult> {
    const run = () => this.runTurnInner(prompt);
    // `run` is passed as both handlers so a turn starts whether or not the
    // previous one rejected; the swallow-chain below replaces the queue with an
    // always-fulfilled promise so one failed turn never poisons the queue or
    // raises an unhandled rejection.
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  dispose(): void {
    this.session?.dispose();
  }

  /** Abort the in-flight turn, if any. No-op before the first turn creates the session. */
  async abort(): Promise<void> {
    await this.session?.abort();
  }

  private async getSession(): Promise<PeerSessionHandle> {
    if (!this.session) this.session = await this.deps.createSession();
    return this.session;
  }

  private async runTurnInner(prompt: string): Promise<SessionResult> {
    // Mark busy before the first await: a hang during session creation is still a
    // stalled turn and must stay detectable (A5).
    this.busy = true;
    const s = await this.getSession();
    const acc: TurnAcc = {};
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    // Usage, stop reason, and text deltas arrive only through subscribe;
    // prompt() resolves with no result. The turn is bounded by agent_settled.
    // ponytail: agent_settled is redundant in the real SDK (prompt() already
    // awaits the whole run) but the unit tests encode it as the turn-completion
    // gate; deleting it needs a test rework, so we keep it until a hang is seen.
    const unsub = s.subscribe((raw) => {
      const e = raw as AgentSessionEvent;
      if (PROGRESS_EVENTS.has(e.type)) this.progressed = true;
      // RT-10: surface the agent-level retry so a transient provider error leaves a
      // trace. Cleared when the retry ends (auto_retry_end) — a turn that recovers
      // shows the attempt count on the bus instead of vanishing into the session.
      if (e.type === "auto_retry_start")
        this.retry = { attempt: e.attempt, maxAttempts: e.maxAttempts };
      else if (e.type === "auto_retry_end") this.retry = undefined;
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
        this.deps.onTextDelta(e.assistantMessageEvent.delta);
      } else if (e.type === "message_end") {
        absorbMessageEnd(e, acc);
      } else if (e.type === "agent_settled") {
        settle();
      }
    });
    try {
      await s.prompt(prompt);
      await settled;
      return {
        report: s.getLastAssistantText() ?? "",
        usage: acc.usage,
        stopReason: acc.stopReason,
        errorMessage: acc.errorMessage,
      };
    } finally {
      this.busy = false;
      this.retry = undefined;
      unsub();
    }
  }
}
