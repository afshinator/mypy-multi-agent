import type { SessionResult, SessionUsage } from "./peer-harness";

export interface PeerSessionHandle {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
}

export interface PeerSessionDeps {
  createSession: () => Promise<PeerSessionHandle>;
  onTextDelta: (delta: string) => void;
}

/**
 * One peer session reused across turns until the ask ends. Turns are serialized
 * so an inbound message never interleaves with an in-flight turn; the in-memory
 * transcript persists across prompts, giving the peer memory of its earlier work.
 */
export class PeerSession {
  private session: PeerSessionHandle | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PeerSessionDeps) {}

  runTurn(prompt: string): Promise<SessionResult> {
    const run = () => this.runTurnInner(prompt);
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

  private async getSession(): Promise<PeerSessionHandle> {
    if (!this.session) this.session = await this.deps.createSession();
    return this.session;
  }

  private async runTurnInner(prompt: string): Promise<SessionResult> {
    const s = await this.getSession();
    let usage: SessionUsage | undefined;
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const unsub = s.subscribe((raw) => {
      const e = raw as {
        type?: string;
        assistantMessageEvent?: { type?: string; delta?: string };
        message?: { role?: string; usage?: { cost: { total: number }; totalTokens: number } };
      };
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta" && e.assistantMessageEvent.delta !== undefined) {
        this.deps.onTextDelta(e.assistantMessageEvent.delta);
      }
      if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) {
        usage = { cost: e.message.usage.cost.total, tokens: e.message.usage.totalTokens };
      }
      if (e.type === "agent_settled") settle();
    });
    try {
      await s.prompt(prompt);
      await settled;
      return { report: s.getLastAssistantText() ?? "", usage };
    } finally {
      unsub();
    }
  }
}
