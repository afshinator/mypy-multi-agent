/**
 * Unit tests for PeerTraceState: turn/tool span lifecycle and abort closure.
 */
import { describe, expect, it } from "vitest";
import { PeerTraceState } from "../../src/tracing/peer-trace";
import { FieldsTracer } from "../../src/tracing/tracing";

describe("PeerTraceState", () => {
  it("parents tool spans to the active turn and inherits its scope", () => {
    const tracer = new FieldsTracer();
    const state = new PeerTraceState(tracer);
    const turn = state.startTurn(null, "t1", "peer1");
    const tool = state.startTool("tool-1", "read", "peer1");
    if (!tool) throw new Error("expected tool span");
    state.endTool(tool, "ok");
    state.endTurn("ok");
    const spans = tracer.collect();
    const turnRecord = spans.find((s) => s.name === "peer.turn");
    const toolRecord = spans.find((s) => s.name === "tool");
    expect(toolRecord).toMatchObject({
      parent_span_id: turn.id,
      scope_id: "t1",
      agent_id: "peer1",
      operation_id: "tool-1",
      attributes: { tool: "read" },
      end_time: expect.any(Number),
    });
    expect(turnRecord).toMatchObject({ scope_id: "t1", end_time: expect.any(Number) });
  });

  it("an aborted turn closes its open tool spans with status aborted", () => {
    const tracer = new FieldsTracer();
    const state = new PeerTraceState(tracer);
    state.startTurn(null, "t1", "peer1");
    state.startTool("tool-1", "bash", "peer1");
    state.startTool("tool-2", "read", "peer1");
    state.endTurn("aborted");
    expect(tracer.collect().every((s) => s.status === "aborted" && s.end_time !== null)).toBe(true);
  });

  it("startTurnFrom mints nothing when the envelope has no traceparent", () => {
    const tracer = new FieldsTracer();
    const state = new PeerTraceState(tracer);
    expect(state.startTurnFrom({}, "t1", "peer1")).toBeNull();
    expect(tracer.collect()).toEqual([]);
  });
});
