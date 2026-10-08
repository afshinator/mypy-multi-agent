/**
 * Unit tests for the peer session module.
 */
import { describe, expect, it, vi } from "vitest";
import { PeerSession } from "../../src/peer/peer-session";

function makeFake() {
  let lastText = "";
  let prompts = 0;
  let disposed = false;
  let aborted = 0;
  const listeners = new Set<(e: unknown) => void>();
  return {
    get prompts() {
      return prompts;
    },
    get disposed() {
      return disposed;
    },
    get aborted() {
      return aborted;
    },
    emit(e: unknown) {
      for (const l of listeners) l(e);
    },
    handle: {
      prompt: async (text: string) => {
        prompts++;
        lastText = `reply to ${text}`;
      },
      getLastAssistantText: () => lastText,
      subscribe: (l: (e: unknown) => void) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      dispose: () => {
        disposed = true;
      },
      abort: async () => {
        aborted++;
      },
    },
  };
}

/** Start a turn, wait until its prompt is issued, then settle it. */
async function turn(ps: PeerSession, fake: ReturnType<typeof makeFake>, text: string) {
  const target = fake.prompts + 1;
  const p = ps.runTurn(text);
  await vi.waitFor(() => expect(fake.prompts).toBe(target));
  fake.emit({ type: "agent_settled" });
  await p;
}

describe("PeerSession", () => {
  it("reuses one session across turns", async () => {
    const fake = makeFake();
    const createSession = vi.fn(async () => fake.handle);
    const ps = new PeerSession({ createSession, onTextDelta: vi.fn() });
    await turn(ps, fake, "a");
    await turn(ps, fake, "b");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(fake.prompts).toBe(2);
  });

  it("serializes turns (no concurrent prompts)", async () => {
    const fake = makeFake();
    const ps = new PeerSession({ createSession: async () => fake.handle, onTextDelta: vi.fn() });
    const p1 = ps.runTurn("a");
    await vi.waitFor(() => expect(fake.prompts).toBe(1));
    void ps.runTurn("b");
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.prompts).toBe(1);
    fake.emit({ type: "agent_settled" });
    await p1;
    await vi.waitFor(() => expect(fake.prompts).toBe(2));
    fake.emit({ type: "agent_settled" });
  });

  it("captures the report and usage from the settled turn", async () => {
    const fake = makeFake();
    const ps = new PeerSession({ createSession: async () => fake.handle, onTextDelta: vi.fn() });
    const p = ps.runTurn("x");
    await vi.waitFor(() => expect(fake.prompts).toBe(1));
    fake.emit({
      type: "message_end",
      message: { role: "assistant", usage: { cost: { total: 0.5 }, totalTokens: 100 } },
    });
    fake.emit({ type: "agent_settled" });
    await expect(p).resolves.toEqual({ report: "reply to x", usage: { cost: 0.5, tokens: 100 } });
  });

  it("accumulates usage across multiple assistant messages", async () => {
    const fake = makeFake();
    const ps = new PeerSession({ createSession: async () => fake.handle, onTextDelta: vi.fn() });
    const p = ps.runTurn("x");
    await vi.waitFor(() => expect(fake.prompts).toBe(1));
    fake.emit({
      type: "message_end",
      message: { role: "assistant", usage: { cost: { total: 0.5 }, totalTokens: 100 } },
    });
    fake.emit({
      type: "message_end",
      message: { role: "assistant", usage: { cost: { total: 0.25 }, totalTokens: 50 } },
    });
    fake.emit({ type: "agent_settled" });
    await expect(p).resolves.toMatchObject({ usage: { cost: 0.75, tokens: 150 } });
  });

  it("captures the final assistant stop reason", async () => {
    const fake = makeFake();
    const ps = new PeerSession({ createSession: async () => fake.handle, onTextDelta: vi.fn() });
    const p = ps.runTurn("x");
    await vi.waitFor(() => expect(fake.prompts).toBe(1));
    fake.emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "upstream unavailable" },
    });
    fake.emit({ type: "agent_settled" });
    await expect(p).resolves.toMatchObject({
      report: "reply to x",
      stopReason: "error",
      errorMessage: "upstream unavailable",
    });
  });

  it("streams text deltas", async () => {
    const fake = makeFake();
    const onTextDelta = vi.fn();
    const ps = new PeerSession({ createSession: async () => fake.handle, onTextDelta });
    const p = ps.runTurn("x");
    await vi.waitFor(() => expect(fake.prompts).toBe(1));
    fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    fake.emit({ type: "agent_settled" });
    await p;
    expect(onTextDelta).toHaveBeenCalledWith("hi");
  });

  it("disposes the shared session once", async () => {
    const fake = makeFake();
    const ps = new PeerSession({ createSession: async () => fake.handle, onTextDelta: vi.fn() });
    await turn(ps, fake, "a");
    ps.dispose();
    expect(fake.disposed).toBe(true);
  });

  it("aborts the underlying session when created", async () => {
    const fake = makeFake();
    const ps = new PeerSession({ createSession: async () => fake.handle, onTextDelta: vi.fn() });
    await turn(ps, fake, "a");
    await ps.abort();
    expect(fake.aborted).toBe(1);
  });

  it("abort before session creation is a no-op", async () => {
    const fake = makeFake();
    const ps = new PeerSession({ createSession: async () => fake.handle, onTextDelta: vi.fn() });
    await expect(ps.abort()).resolves.toBeUndefined();
    expect(fake.aborted).toBe(0);
  });
});
