/**
 * Peer-side tracing wiring: WORK_ORDER/PROMPT extract a traceparent and mint a
 * peer.turn around the turn, closed ok/error/aborted. Uses the real
 * PeerTraceState for span assertions, and a mock for the abort-call contract.
 */
import { describe, expect, it, vi } from "vitest";
import { handleInboundLine } from "../../src/peer/peer-harness";
import { PeerTraceState } from "../../src/tracing/peer-trace";
import { FieldsTracer } from "../../src/tracing/tracing";

const raw = (e: unknown) => `${JSON.stringify(e)}\n`;
const TRACE_ID = "a".repeat(32);
const SPAN_ID = "b".repeat(16);
const tp = `00-${TRACE_ID}-${SPAN_ID}-01`;

const base = () => ({
  agentId: "peer1",
  runTurn: vi.fn(async () => ({ report: "r" })),
  send: vi.fn(),
  stop: vi.fn(),
  onDone: vi.fn(),
  onError: vi.fn(),
});

describe("peer-harness tracing", () => {
  it("WORK_ORDER extracts traceparent and mints peer.turn, closing it ok", async () => {
    const tracer = new FieldsTracer();
    const d = { ...base(), trace: new PeerTraceState(tracer) };
    handleInboundLine(
      raw({
        id: "w",
        traceparent: tp,
        sender: "supervisor",
        type: "WORK_ORDER",
        payload: {
          taskId: "t1",
          action: "do x",
          contextFiles: [],
          constraints: [],
          localDoD: "d",
        },
      }),
      d,
    );
    await vi.waitFor(() => expect(d.send).toHaveBeenCalledOnce());
    const turn = tracer.collect().find((s) => s.name === "peer.turn");
    expect(turn).toMatchObject({
      trace_id: TRACE_ID,
      parent_span_id: SPAN_ID,
      scope_id: "t1",
      agent_id: "peer1",
      end_time: expect.any(Number),
    });
  });

  it("PROMPT extracts traceparent and mints peer.turn scoped to correlationId", async () => {
    const tracer = new FieldsTracer();
    const d = { ...base(), trace: new PeerTraceState(tracer) };
    handleInboundLine(
      raw({
        id: "p",
        traceparent: tp,
        correlationId: "c1",
        sender: "supervisor",
        type: "PROMPT",
        payload: { agentId: "peer1", text: "q" },
      }),
      d,
    );
    await vi.waitFor(() => expect(d.send).toHaveBeenCalledOnce());
    const turn = tracer.collect().find((s) => s.name === "peer.turn");
    expect(turn).toMatchObject({ parent_span_id: SPAN_ID, scope_id: "c1", agent_id: "peer1" });
  });

  it("a turn rejection closes the turn with error", async () => {
    const tracer = new FieldsTracer();
    const d = {
      ...base(),
      trace: new PeerTraceState(tracer),
      runTurn: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    handleInboundLine(
      raw({
        id: "w",
        traceparent: tp,
        sender: "supervisor",
        type: "WORK_ORDER",
        payload: {
          taskId: "t1",
          action: "do x",
          contextFiles: [],
          constraints: [],
          localDoD: "d",
        },
      }),
      d,
    );
    await vi.waitFor(() => expect(d.onError).toHaveBeenCalledOnce());
    expect(tracer.collect().find((s) => s.name === "peer.turn")).toMatchObject({
      status: "error",
      end_time: expect.any(Number),
    });
  });

  it("a stop signal aborts the open turn", () => {
    const trace = {
      startTurnFrom: vi.fn(() => "turn"),
      endTurn: vi.fn(),
    } as unknown as PeerTraceState;
    const d = { ...base(), trace };
    expect(handleInboundLine(raw({ id: "s", type: "STOP_ALL", payload: {} }), d)).toBe(false);
    expect(trace.endTurn).toHaveBeenCalledWith("aborted");
  });

  it("an unrelated line mints no turn", () => {
    const trace = {
      startTurnFrom: vi.fn(),
      endTurn: vi.fn(),
    } as unknown as PeerTraceState;
    const d = { ...base(), trace };
    expect(handleInboundLine(raw({ id: "h", type: "HEARTBEAT", payload: {} }), d)).toBe(true);
    expect(trace.startTurnFrom).not.toHaveBeenCalled();
  });

  it("still mints nothing when the trace seam is absent", async () => {
    const d = base();
    handleInboundLine(
      raw({
        id: "w",
        traceparent: tp,
        sender: "supervisor",
        type: "WORK_ORDER",
        payload: {
          taskId: "t1",
          action: "do x",
          contextFiles: [],
          constraints: [],
          localDoD: "d",
        },
      }),
      d,
    );
    await vi.waitFor(() => expect(d.send).toHaveBeenCalledOnce());
    expect(d.onError).not.toHaveBeenCalled();
  });
});
