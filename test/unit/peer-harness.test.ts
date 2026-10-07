/**
 * Unit tests for the peer harness module.
 */
import { describe, expect, it, vi } from "vitest";
import { handleWorkOrder, isStopSignal } from "../../src/peer/peer-harness";
import { payloadSchemas } from "../../src/contracts/a2a-schema";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

const env = (type: string, payload: unknown): A2AEnvelope =>
  ({ id: "e1", timestamp: 0, sender: "supervisor", recipient: "peer1", type, payload }) as A2AEnvelope;

describe("isStopSignal", () => {
  it("STOP_AGENT for this agent is a stop", () => {
    expect(isStopSignal(env("STOP_AGENT", { agentId: "peer1" }), "peer1")).toBe(true);
  });

  it("STOP_AGENT for another agent is not a stop", () => {
    expect(isStopSignal(env("STOP_AGENT", { agentId: "peer2" }), "peer1")).toBe(false);
  });

  it("STOP_ALL is a stop for any agent", () => {
    expect(isStopSignal(env("STOP_ALL", {}), "peer1")).toBe(true);
  });

  it("KILL_ALL is a stop for any agent", () => {
    expect(isStopSignal(env("KILL_ALL", {}), "peer1")).toBe(true);
  });

  it("WORK_ORDER is not a stop", () => {
    expect(isStopSignal(env("WORK_ORDER", { taskId: "t", action: "a", contextFiles: [], constraints: [], localDoD: "d" }), "peer1")).toBe(false);
  });

  it("PROMPT is not a stop", () => {
    expect(isStopSignal(env("PROMPT", { agentId: "peer1", text: "hi" }), "peer1")).toBe(false);
  });
});

describe("handleWorkOrder", () => {
  it("runs the session and emits a FINAL_REPORT", async () => {
    const runSession = vi.fn(async () => ({ report: "the report" }));
    const send = vi.fn();
    const result = await handleWorkOrder("peer1", "do x", { runSession, send, now: () => 123 });
    expect(result.report).toBe("the report");
    expect(runSession).toHaveBeenCalledWith("do x");
    expect(send).toHaveBeenCalledOnce();
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("FINAL_REPORT");
    expect(env.sender).toBe("peer1");
    expect(env.recipient).toBe("supervisor");
    expect(env.payload).toMatchObject({ agentId: "peer1", report: "the report" });
    expect(payloadSchemas.FINAL_REPORT.safeParse(env.payload).success).toBe(true);
  });

  it("forwards session usage into the FINAL_REPORT", async () => {
    const runSession = vi.fn(async () => ({ report: "done", usage: { cost: 0.42, tokens: 1234 } }));
    const send = vi.fn();
    await handleWorkOrder("peer1", "do x", { runSession, send, now: () => 123 });
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.payload).toMatchObject({ agentId: "peer1", report: "done", usage: { cost: 0.42, tokens: 1234 } });
    expect(payloadSchemas.FINAL_REPORT.safeParse(env.payload).success).toBe(true);
  });

  it("omits usage when the session reports none", async () => {
    const runSession = vi.fn(async () => ({ report: "done" }));
    const send = vi.fn();
    await handleWorkOrder("peer1", "do x", { runSession, send, now: () => 123 });
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect((env.payload as { usage?: unknown }).usage).toBeUndefined();
  });

  it("runSession failure propagates and sends nothing", async () => {
    const runSession = vi.fn(async () => {
      throw new Error("boom");
    });
    const send = vi.fn();
    await expect(handleWorkOrder("peer1", "do x", { runSession, send, now: () => 123 })).rejects.toThrow("boom");
    expect(send).not.toHaveBeenCalled();
  });
});
