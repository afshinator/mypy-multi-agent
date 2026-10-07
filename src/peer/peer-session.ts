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

/**
 * Turns are serialized so an inbound message never interleaves with an
 * in-flight turn; the in-memory transcript persists across prompts, so the peer
 * keeps memory of its earlier work.
 */
export class PeerSession {
  private session: PeerSessionHandle | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PeerSessionDeps) {}

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
    const s = await this.getSession();
    let usage: SessionUsage | undefined;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    // Usage, stop reason, and text deltas arrive only through subscribe;
    // prompt() resolves with no result. The turn is bounded by agent_settled.
    // ponytail: agent_settled is redundant in the real SDK (prompt() already
    // awaits the whole run) but the unit tests encode it as the turn-completion
    // gate; deleting it needs a test rework, so we keep it until a hang is seen.
    const unsub = s.subscribe((raw) => {
      const e = raw as AgentSessionEvent;
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
        this.deps.onTextDelta(e.assistantMessageEvent.delta);
      }
      if (e.type === "message_end" && e.message.role === "assistant") {
        // A tool-loop turn emits one message_end per request, each carrying only
        // that request's cost; accumulate or the turn undercounts against the
        // peer's max_cost_usd. `usage` stays undefined until the first event so
        // "no usage reported" remains distinguishable from a zero-cost turn.
        if (e.message.usage) {
          usage = {
            cost: (usage?.cost ?? 0) + e.message.usage.cost.total,
            tokens: (usage?.tokens ?? 0) + e.message.usage.totalTokens,
          };
        }
        if (e.message.stopReason !== undefined) {
          stopReason = e.message.stopReason;
          errorMessage = e.message.errorMessage;
        }
      }
      if (e.type === "agent_settled") settle();
    });
    try {
      await s.prompt(prompt);
      await settled;
      return { report: s.getLastAssistantText() ?? "", usage, stopReason, errorMessage };
    } finally {
      unsub();
    }
  }
}
