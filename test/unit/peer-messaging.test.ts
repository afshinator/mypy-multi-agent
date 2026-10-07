/**
 * Unit tests for the peer messaging module.
 */
import { describe, expect, it, vi } from "vitest";
import { PeerMessaging } from "../../src/runtime/peer-messaging";
import { CorrelationRegistry } from "../../src/runtime/correlation-registry";
import { SessionState } from "../../src/control/session-state";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import type { AgentState } from "../../src/runtime/state-machine";

const prompt = (correlationId: string, to = "b"): A2AEnvelope => ({
  id: "p1",
  correlationId,
  timestamp: 0,
  sender: "a",
  recipient: to,
  type: "PROMPT",
  payload: { agentId: to, text: "q" },
});

const resp = (correlationId: string, from = "b", to = "a"): A2AEnvelope => ({
  id: "r1",
  correlationId,
  timestamp: 0,
  sender: from,
  recipient: to,
  type: "RESPONSE",
  payload: { agentId: from, text: "answer" },
});

describe("PeerMessaging", () => {
  it("PROMPT opens a correlation", async () => {
    const r = new CorrelationRegistry();
    const emit = vi.fn();
    const m = new PeerMessaging(r, emit, new SessionState(), new Map());
    const p = m.sendPrompt("a", "b", "q", 1000);
    const env = emit.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("PROMPT");
    expect(env.correlationId).toBeDefined();
    r.resolve(env.correlationId!, resp(env.correlationId!));
    await expect(p).resolves.toEqual(resp(env.correlationId!));
  });

  it("RESPONSE resolves the waiter", async () => {
    const r = new CorrelationRegistry();
    const emit = vi.fn();
    const m = new PeerMessaging(r, emit, new SessionState(), new Map());
    const p = m.sendPrompt("a", "b", "q", 1000);
    const env = emit.mock.calls[0]![0] as A2AEnvelope;
    m.onResponse(resp(env.correlationId!));
    await expect(p).resolves.toMatchObject({ type: "RESPONSE", sender: "b" });
  });

  it("peer-to-peer response round-trips with reactivation", async () => {
    const r = new CorrelationRegistry();
    const emit = vi.fn();
    const states = new Map<string, AgentState>([["b", "DONE"]]);
    const m = new PeerMessaging(r, emit, new SessionState(), states);
    const p = m.sendPrompt("a", "b", "question?", 1000);
    const env = emit.mock.calls[0]![0] as A2AEnvelope;
    m.onPrompt(env);
    expect(states.get("b")).toBe("WORKING");
    m.onResponse(resp(env.correlationId!));
    await expect(p).resolves.toMatchObject({ sender: "b", type: "RESPONSE" });
  });

  it("DONE peer reactivates to WORKING", () => {
    const states = new Map<string, AgentState>([["b", "DONE"]]);
    const m = new PeerMessaging(new CorrelationRegistry(), vi.fn(), new SessionState(), states);
    m.onPrompt(prompt("c1", "b"));
    expect(states.get("b")).toBe("WORKING");
  });

  it("target crash fails the request", async () => {
    const r = new CorrelationRegistry();
    const emit = vi.fn();
    const m = new PeerMessaging(r, emit, new SessionState(), new Map());
    const p = m.sendPrompt("a", "b", "q", 1000);
    const env = emit.mock.calls[0]![0] as A2AEnvelope;
    r.fail(env.correlationId!, "crashed");
    await expect(p).rejects.toThrow("crashed");
  });

  it("FINALIZING prevents reactivation", () => {
    const s = new SessionState();
    s.enterFinalizing();
    const states = new Map<string, AgentState>([["b", "DONE"]]);
    const m = new PeerMessaging(new CorrelationRegistry(), vi.fn(), s, states);
    m.onPrompt(prompt("c1", "b"));
    expect(states.get("b")).toBe("DONE");
  });

  it("awaitResponse resolves on an inbound PROMPT", async () => {
    const m = new PeerMessaging(new CorrelationRegistry(), vi.fn(), new SessionState(), new Map());
    const p = m.awaitResponse("b", 1000);
    m.onPrompt(prompt("c1", "b"));
    await expect(p).resolves.toMatchObject({ type: "PROMPT", payload: { text: "q" } });
  });

  it("awaitResponse resolves on an inbound RESPONSE addressed to the caller", async () => {
    const m = new PeerMessaging(new CorrelationRegistry(), vi.fn(), new SessionState(), new Map());
    const p = m.awaitResponse("a", 1000);
    m.onResponse(resp("x", "b", "a"));
    await expect(p).resolves.toMatchObject({ type: "RESPONSE", sender: "b" });
  });

  it("awaitResponse resolves on a message sent BY the awaited peer", async () => {
    const m = new PeerMessaging(new CorrelationRegistry(), vi.fn(), new SessionState(), new Map());
    const p = m.awaitResponse("b", 1000);
    // RESPONSE from b, addressed to a — must wake await:b (D1).
    m.onResponse(resp("x", "b", "a"));
    await expect(p).resolves.toMatchObject({ type: "RESPONSE", sender: "b" });
  });

  it("awaitResponse for one peer is not woken by another peer", async () => {
    const m = new PeerMessaging(new CorrelationRegistry(), vi.fn(), new SessionState(), new Map());
    const p = m.awaitResponse("b", 40);
    m.onResponse(resp("x", "c", "a"));
    await expect(p).rejects.toThrow("timed out");
  });

  it("awaitResponse resolves on a FINAL_REPORT from the awaited peer", async () => {
    const m = new PeerMessaging(new CorrelationRegistry(), vi.fn(), new SessionState(), new Map());
    const p = m.awaitResponse("dev_a", 1000);
    m.onResponse({
      id: "f1", timestamp: 0, sender: "dev_a", recipient: "supervisor", type: "FINAL_REPORT",
      payload: { agentId: "dev_a", report: "r" },
    });
    await expect(p).resolves.toMatchObject({ type: "FINAL_REPORT", sender: "dev_a" });
  });

  it("awaitResponse rejects on timeout", async () => {
    const m = new PeerMessaging(new CorrelationRegistry(), vi.fn(), new SessionState(), new Map());
    await expect(m.awaitResponse("b", 30)).rejects.toThrow("timed out");
  });

  it("awaitResponse rejects immediately when FINALIZING", async () => {
    const s = new SessionState();
    s.enterFinalizing();
    const m = new PeerMessaging(new CorrelationRegistry(), vi.fn(), s, new Map());
    await expect(m.awaitResponse("b", 1000)).rejects.toThrow("finalizing");
  });
});
