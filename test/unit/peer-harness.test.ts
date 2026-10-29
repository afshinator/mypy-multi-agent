/**
 * Unit tests for the peer harness module.
 */
import { describe, expect, it, vi } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { payloadSchemas } from "../../src/contracts/a2a-schema";
import { handleInboundLine, handleWorkOrder, isStopSignal } from "../../src/peer/peer-harness";

const env = (type: string, payload: unknown): A2AEnvelope =>
  ({
    id: "e1",
    timestamp: 0,
    sender: "supervisor",
    recipient: "peer1",
    type,
    payload,
  }) as A2AEnvelope;

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
    expect(
      isStopSignal(
        env("WORK_ORDER", {
          taskId: "t",
          action: "a",
          contextFiles: [],
          constraints: [],
          localDoD: "d",
        }),
        "peer1",
      ),
    ).toBe(false);
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
    expect(env.payload).toMatchObject({
      agentId: "peer1",
      report: "done",
      usage: { cost: 0.42, tokens: 1234 },
    });
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
    await expect(
      handleWorkOrder("peer1", "do x", { runSession, send, now: () => 123 }),
    ).rejects.toThrow("boom");
    expect(send).not.toHaveBeenCalled();
  });

  it("retries an empty report, pausing before each attempt", async () => {
    const runSession = vi
      .fn()
      .mockResolvedValueOnce({ report: "" })
      .mockResolvedValueOnce({ report: "filled", usage: { cost: 0.1, tokens: 50 } });
    const send = vi.fn();
    const sleep = vi.fn(async () => {});
    const result = await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send, now: () => 123, sleep },
      { maxRetries: 3, pauseMs: 5000 },
    );
    expect(runSession).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(result.report).toBe("filled");
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.payload).toMatchObject({ agentId: "peer1", report: "filled" });
  });

  it("retries on stopReason error, pausing before each attempt", async () => {
    const runSession = vi
      .fn()
      .mockResolvedValueOnce({
        report: "",
        stopReason: "error",
        errorMessage: "upstream unavailable",
      })
      .mockResolvedValueOnce({ report: "recovered", usage: { cost: 0.1, tokens: 20 } });
    const send = vi.fn();
    const sleep = vi.fn(async () => {});
    const result = await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send, now: () => 123, sleep },
      { maxRetries: 3, pauseMs: 5000 },
    );
    expect(runSession).toHaveBeenCalledTimes(2);
    expect(result.report).toBe("recovered");
  });

  it("does not retry a terminal provider error, whatever the report says", async () => {
    // A 4xx other than 408/409/429 fails identically next time; retrying it is
    // what cost a real run 4 attempts across 2 restart rounds.
    const runSession = vi.fn(async () => ({
      report: "",
      stopReason: "error",
      errorMessage: '412: {"message":"Account suspended"}',
    }));
    const sleep = vi.fn(async () => {});
    await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send: vi.fn(), now: () => 123, sleep },
      { maxRetries: 3, pauseMs: 5000 },
    );
    expect(runSession).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("still retries a transient 429", async () => {
    const runSession = vi
      .fn()
      .mockResolvedValueOnce({ report: "", stopReason: "error", errorMessage: "429: slow down" })
      .mockResolvedValueOnce({ report: "recovered", usage: { cost: 0.1, tokens: 20 } });
    const result = await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send: vi.fn(), now: () => 123, sleep: vi.fn(async () => {}) },
      { maxRetries: 3, pauseMs: 5000 },
    );
    expect(runSession).toHaveBeenCalledTimes(2);
    expect(result.report).toBe("recovered");
  });

  it("gives up after maxRetries and emits AGENT_UNUSABLE for a mute peer", async () => {
    const runSession = vi.fn(async () => ({
      report: "",
      stopReason: "error",
      errorMessage: "upstream unavailable",
    }));
    const send = vi.fn();
    const sleep = vi.fn(async () => {});
    const result = await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send, now: () => 123, sleep },
      { maxRetries: 2, pauseMs: 1000 },
    );
    expect(runSession).toHaveBeenCalledTimes(3); // first + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.report).toBe("");
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("AGENT_UNUSABLE");
    expect(env.payload).toMatchObject({ agentId: "peer1", attempts: 3 });
    expect(payloadSchemas.AGENT_UNUSABLE.safeParse(env.payload).success).toBe(true);
  });

  it("AGENT_UNUSABLE carries the turn's errorMessage as the cause", async () => {
    const runSession = vi.fn(async () => ({
      report: "",
      stopReason: "error",
      errorMessage: "402 Insufficient account funds",
    }));
    const send = vi.fn();
    const sleep = vi.fn(async () => {});
    await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send, now: () => 123, sleep },
      { maxRetries: 1, pauseMs: 1000 },
    );
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("AGENT_UNUSABLE");
    expect(env.payload).toMatchObject({
      agentId: "peer1",
      reason: "empty model output",
      attempts: 2,
      error: "402 Insufficient account funds",
    });
    expect(payloadSchemas.AGENT_UNUSABLE.safeParse(env.payload).success).toBe(true);
  });

  it("AGENT_UNUSABLE falls back to a non-stop stopReason and omits error otherwise", async () => {
    const runSession = vi.fn(async () => ({ report: "", stopReason: "error" }));
    const send = vi.fn();
    await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send, now: () => 123, sleep: vi.fn(async () => {}) },
      { maxRetries: 0, pauseMs: 1000 },
    );
    const withError = send.mock.calls[0]![0] as A2AEnvelope;
    expect((withError.payload as { error?: unknown }).error).toBe("error");
    expect(payloadSchemas.AGENT_UNUSABLE.safeParse(withError.payload).success).toBe(true);

    const clean = vi.fn();
    const runClean = vi.fn(async () => ({ report: "", stopReason: "stop" }));
    await handleWorkOrder(
      "peer1",
      "do x",
      { runSession: runClean, send: clean, now: () => 123, sleep: vi.fn(async () => {}) },
      { maxRetries: 0, pauseMs: 1000 },
    );
    const noError = clean.mock.calls[0]![0] as A2AEnvelope;
    expect(noError.type).toBe("AGENT_UNUSABLE");
    expect((noError.payload as { error?: unknown }).error).toBeUndefined();
    expect(Object.keys(noError.payload as object)).toEqual(["agentId", "reason", "attempts"]);
    expect(payloadSchemas.AGENT_UNUSABLE.safeParse(noError.payload).success).toBe(true);
  });

  it("AGENT_UNUSABLE: an empty errorMessage does not mask a non-stop stopReason", async () => {
    const runSession = vi.fn(async () => ({ report: "", errorMessage: "", stopReason: "error" }));
    const send = vi.fn();
    await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send, now: () => 123, sleep: vi.fn(async () => {}) },
      { maxRetries: 0, pauseMs: 1000 },
    );
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("AGENT_UNUSABLE");
    expect((env.payload as { error?: unknown }).error).toBe("error");
    expect(payloadSchemas.AGENT_UNUSABLE.safeParse(env.payload).success).toBe(true);
  });

  it("an empty report with nonzero usage is still a normal FINAL_REPORT", async () => {
    const runSession = vi.fn(async () => ({ report: "", usage: { cost: 0.1, tokens: 50 } }));
    const send = vi.fn();
    const sleep = vi.fn(async () => {});
    await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send, now: () => 123, sleep },
      { maxRetries: 1, pauseMs: 1000 },
    );
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("FINAL_REPORT");
  });

  it("no retry when maxRetries is 0", async () => {
    const runSession = vi.fn(async () => ({ report: "" }));
    const send = vi.fn();
    const sleep = vi.fn(async () => {});
    await handleWorkOrder(
      "peer1",
      "do x",
      { runSession, send, now: () => 123, sleep },
      { maxRetries: 0, pauseMs: 1000 },
    );
    expect(runSession).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("whitespace-only report also retries", async () => {
    const runSession = vi
      .fn()
      .mockResolvedValueOnce({ report: "  \n " })
      .mockResolvedValueOnce({ report: "ok" });
    const send = vi.fn();
    const sleep = vi.fn(async () => {});
    await handleWorkOrder("peer1", "do x", { runSession, send, now: () => 123, sleep });
    expect(runSession).toHaveBeenCalledTimes(2);
  });
});

describe("handleInboundLine", () => {
  const base = () => ({
    agentId: "peer1",
    runTurn: vi.fn(async () => ({ report: "r" })),
    send: vi.fn(),
    stop: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  });
  const raw = (e: unknown) => `${JSON.stringify(e)}\n`;

  it("ignores blank and malformed lines", () => {
    const d = base();
    expect(handleInboundLine("  ", d)).toBe(true);
    expect(handleInboundLine("{bad", d)).toBe(true);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("stop signal calls stop and returns false", () => {
    const d = base();
    expect(handleInboundLine(raw({ id: "s", type: "STOP_ALL", payload: {} }), d)).toBe(false);
    expect(d.stop).toHaveBeenCalledOnce();
  });

  it("stop for another agent is ignored", () => {
    const d = base();
    expect(
      handleInboundLine(raw({ id: "s", type: "STOP_AGENT", payload: { agentId: "other" } }), d),
    ).toBe(true);
    expect(d.stop).not.toHaveBeenCalled();
  });

  it("WORK_ORDER runs the turn and reports", async () => {
    const d = base();
    handleInboundLine(
      raw({
        id: "w",
        type: "WORK_ORDER",
        payload: { taskId: "t", action: "do x", contextFiles: [], constraints: [], localDoD: "d" },
      }),
      d,
    );
    await vi.waitFor(() => expect(d.send).toHaveBeenCalledOnce());
    expect(d.runTurn).toHaveBeenCalledWith("do x");
    expect((d.send.mock.calls[0]![0] as A2AEnvelope).type).toBe("FINAL_REPORT");
    expect(d.onDone).toHaveBeenCalledOnce();
  });

  it("PROMPT runs the turn and replies with the correlation", async () => {
    const d = base();
    handleInboundLine(
      raw({
        id: "p",
        correlationId: "c1",
        sender: "supervisor",
        type: "PROMPT",
        payload: { agentId: "peer1", text: "q" },
      }),
      d,
    );
    await vi.waitFor(() => expect(d.send).toHaveBeenCalledOnce());
    expect(d.send.mock.calls[0]![0]).toMatchObject({
      type: "RESPONSE",
      correlationId: "c1",
      recipient: "supervisor",
      payload: { text: "r" },
    });
  });

  it("PROMPT replies include session usage", async () => {
    const send = vi.fn();
    const runTurn = vi.fn(async () => ({ report: "r", usage: { cost: 0.25, tokens: 500 } }));
    const d = { agentId: "peer1", runTurn, send, stop: vi.fn(), onDone: vi.fn(), onError: vi.fn() };
    handleInboundLine(
      raw({
        id: "p",
        correlationId: "c1",
        sender: "supervisor",
        type: "PROMPT",
        payload: { agentId: "peer1", text: "q" },
      }),
      d,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.payload).toMatchObject({
      agentId: "peer1",
      text: "r",
      usage: { cost: 0.25, tokens: 500 },
    });
    expect(payloadSchemas.RESPONSE.safeParse(env.payload).success).toBe(true);
  });

  it("PROMPT reply carries reviewer criteria parsed from a fenced JSON block", async () => {
    const report = 'verdict\n```json\n[{"criterion":"a","result":"pass","evidence":"file:1"}]\n```';
    const send = vi.fn();
    const runTurn = vi.fn(async () => ({ report }));
    const d = {
      agentId: "reviewer",
      runTurn,
      send,
      stop: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    handleInboundLine(
      raw({
        id: "p",
        correlationId: "c1",
        sender: "supervisor",
        type: "PROMPT",
        payload: { agentId: "reviewer", text: "q" },
      }),
      d,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const sent = send.mock.calls[0]![0] as A2AEnvelope;
    expect((sent.payload as { criteria: unknown }).criteria).toEqual([
      { criterion: "a", result: "pass", evidence: "file:1" },
    ]);
    expect(payloadSchemas.RESPONSE.safeParse(sent.payload).success).toBe(true);
  });

  it("WORK_ORDER report carries reviewer criteria parsed from a fenced JSON block (RT-9 G2)", async () => {
    const report = 'verdict\n```json\n[{"criterion":"a","result":"pass","evidence":"file:1"}]\n```';
    const send = vi.fn();
    const runTurn = vi.fn(async () => ({ report }));
    handleInboundLine(
      raw({
        id: "w",
        sender: "supervisor",
        type: "WORK_ORDER",
        payload: { agentId: "reviewer", action: "attest" },
      }),
      {
        agentId: "reviewer",
        runTurn,
        send,
        stop: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const sent = send.mock.calls[0]![0] as A2AEnvelope;
    expect(sent.type).toBe("FINAL_REPORT");
    expect((sent.payload as { criteria: unknown }).criteria).toEqual([
      { criterion: "a", result: "pass", evidence: "file:1" },
    ]);
    expect(payloadSchemas.FINAL_REPORT.safeParse(sent.payload).success).toBe(true);
  });

  it("PROMPT: an empty reply is retried and a real second reply ships as RESPONSE", async () => {
    const send = vi.fn();
    const runTurn = vi
      .fn()
      .mockResolvedValueOnce({ report: "", usage: { cost: 0.01, tokens: 5 } })
      .mockResolvedValueOnce({ report: "the answer", usage: { cost: 0.02, tokens: 10 } });
    const sleep = vi.fn(async () => {});
    const d = {
      agentId: "peer1",
      runTurn,
      send,
      stop: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      sleep,
      retry: { maxRetries: 2, pauseMs: 1000 },
    };
    handleInboundLine(
      raw({
        id: "p",
        correlationId: "c1",
        sender: "supervisor",
        type: "PROMPT",
        payload: { agentId: "peer1", text: "q" },
      }),
      d,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("RESPONSE");
    expect(env.payload).toMatchObject({ agentId: "peer1", text: "the answer" });
  });

  it("PROMPT: a non-empty first reply ships immediately, no retry", async () => {
    const send = vi.fn();
    const runTurn = vi.fn(async () => ({ report: "answer", usage: { cost: 0.01, tokens: 5 } }));
    const sleep = vi.fn(async () => {});
    const d = {
      agentId: "peer1",
      runTurn,
      send,
      stop: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      sleep,
      retry: { maxRetries: 2, pauseMs: 1000 },
    };
    handleInboundLine(
      raw({
        id: "p",
        correlationId: "c1",
        sender: "supervisor",
        type: "PROMPT",
        payload: { agentId: "peer1", text: "q" },
      }),
      d,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(runTurn).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect((send.mock.calls[0]![0] as A2AEnvelope).type).toBe("RESPONSE");
  });

  it("PROMPT: empty replies that exhaust retries emit AGENT_UNUSABLE with attempts", async () => {
    const send = vi.fn();
    // Metered but empty — the run-2 reviewer signature; retries then escalate.
    const runTurn = vi.fn(async () => ({ report: "  ", usage: { cost: 0.01, tokens: 5 } }));
    const sleep = vi.fn(async () => {});
    const d = {
      agentId: "peer1",
      runTurn,
      send,
      stop: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      sleep,
      retry: { maxRetries: 2, pauseMs: 1000 },
    };
    handleInboundLine(
      raw({
        id: "p",
        correlationId: "c1",
        sender: "supervisor",
        type: "PROMPT",
        payload: { agentId: "peer1", text: "q" },
      }),
      d,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(runTurn).toHaveBeenCalledTimes(3); // first + 2 retries
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("AGENT_UNUSABLE");
    expect(env.payload).toMatchObject({ agentId: "peer1", attempts: 3 });
    expect(payloadSchemas.AGENT_UNUSABLE.safeParse(env.payload).success).toBe(true);
  });

  it("PROMPT: AGENT_UNUSABLE carries the turn's errorMessage as the cause", async () => {
    const send = vi.fn();
    const runTurn = vi.fn(async () => ({
      report: "",
      stopReason: "error",
      errorMessage: "connection reset by peer",
    }));
    const d = {
      agentId: "peer1",
      runTurn,
      send,
      stop: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      sleep: vi.fn(async () => {}),
      retry: { maxRetries: 1, pauseMs: 1000 },
    };
    handleInboundLine(
      raw({
        id: "p",
        correlationId: "c1",
        sender: "supervisor",
        type: "PROMPT",
        payload: { agentId: "peer1", text: "q" },
      }),
      d,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(runTurn).toHaveBeenCalledTimes(2);
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("AGENT_UNUSABLE");
    expect(env.payload).toMatchObject({
      agentId: "peer1",
      reason: "empty model output",
      attempts: 2,
      error: "connection reset by peer",
    });
    expect(payloadSchemas.AGENT_UNUSABLE.safeParse(env.payload).success).toBe(true);
  });

  it("PROMPT: AGENT_UNUSABLE omits error when the turn reported no cause", async () => {
    const send = vi.fn();
    const runTurn = vi.fn(async () => ({ report: "", usage: { cost: 0.01, tokens: 5 } }));
    const d = {
      agentId: "peer1",
      runTurn,
      send,
      stop: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      sleep: vi.fn(async () => {}),
      retry: { maxRetries: 1, pauseMs: 1000 },
    };
    handleInboundLine(
      raw({
        id: "p",
        correlationId: "c1",
        sender: "supervisor",
        type: "PROMPT",
        payload: { agentId: "peer1", text: "q" },
      }),
      d,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("AGENT_UNUSABLE");
    expect((env.payload as { error?: unknown }).error).toBeUndefined();
    expect(payloadSchemas.AGENT_UNUSABLE.safeParse(env.payload).success).toBe(true);
  });

  it("ignores unrelated envelope types", () => {
    const d = base();
    expect(handleInboundLine(raw({ id: "h", type: "HEARTBEAT", payload: {} }), d)).toBe(true);
    expect(d.runTurn).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });
});
