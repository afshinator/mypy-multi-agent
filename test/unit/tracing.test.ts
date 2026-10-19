/**
 * Unit tests for the production fields-only tracer (src/tracing/tracing.ts).
 */
import { describe, expect, it, vi } from "vitest";
import {
  FieldsTracer,
  formatTraceparent,
  parseTraceparent,
  randomHex,
  type SpanHandle,
} from "../../src/tracing/tracing";

describe("randomHex", () => {
  it("returns the requested byte count as lowercase hex", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("formatTraceparent", () => {
  it("formats a W3C traceparent", () => {
    expect(formatTraceparent("a".repeat(32), "b".repeat(16))).toBe(
      `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    );
  });
});

describe("parseTraceparent", () => {
  it("parses a valid traceparent", () => {
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`)).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
    });
  });

  it("rejects malformed and all-zero ids", () => {
    expect(parseTraceparent("nope")).toBeNull();
    expect(parseTraceparent(`01-${"a".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"0".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-xyz-${"b".repeat(16)}-01`)).toBeNull();
  });
});

describe("FieldsTracer", () => {
  it("mints a root span with parent null", () => {
    const t = new FieldsTracer();
    const run = t.startSpan("run", {
      parent: null,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    const [record] = t.collect();
    expect(record).toMatchObject({
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      parent_span_id: null,
      name: "run",
      kind: "run-level",
      scope_id: null,
      agent_id: null,
      end_time: null,
      status: "ok",
      links: [],
    });
    expect(run.traceId).toBe(record?.trace_id);
  });

  it("startSpan inherits trace_id from its parent handle (D6 fix)", () => {
    const t = new FieldsTracer();
    const run = t.startSpan("run", {
      parent: null,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    t.startSpan("dispatch", {
      parent: run,
      kind: "work-order-level",
      scopeId: "t1",
      agentId: null,
    });
    const spans = t.collect();
    expect(spans.every((s) => s.trace_id === run.traceId)).toBe(true);
    expect(spans.find((s) => s.name === "dispatch")?.parent_span_id).toBe(run.id);
  });

  it("endSpan resolves by span id via a Map (no Array.find)", () => {
    const t = new FieldsTracer();
    const a = t.startSpan("run", {
      parent: null,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    const b = t.startSpan("dispatch", {
      parent: a,
      kind: "work-order-level",
      scopeId: "t1",
      agentId: null,
    });
    const c = t.startSpan("dispatch", {
      parent: a,
      kind: "work-order-level",
      scopeId: "t2",
      agentId: null,
    });
    const find = vi.spyOn(Array.prototype, "find");
    t.endSpan(b);
    find.mockRestore();
    const spans = t.collect();
    expect(spans.find((s) => s.span_id === b.id)?.end_time).not.toBeNull();
    expect(spans.find((s) => s.span_id === a.id)?.end_time).toBeNull();
    expect(spans.find((s) => s.span_id === c.id)?.end_time).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it("endSpan is idempotent: a second close does not overwrite an aborted status", () => {
    const t = new FieldsTracer();
    const h = t.startSpan("run", {
      parent: null,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    t.endSpan(h, "aborted");
    t.endSpan(h, "ok");
    expect(t.collect()[0]).toMatchObject({ status: "aborted" });
  });

  it("inject/extract round-trips the parent context", () => {
    const supervisor = new FieldsTracer();
    const peer = new FieldsTracer();
    const run = supervisor.startSpan("run", {
      parent: null,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    const dispatch = supervisor.startSpan("dispatch", {
      parent: run,
      kind: "work-order-level",
      scopeId: "t1",
      agentId: null,
    });
    const carrier: Record<string, unknown> = {};
    supervisor.inject(carrier, dispatch);
    expect(carrier.traceparent).toBe(formatTraceparent(dispatch.traceId ?? "", dispatch.id));

    const parent: SpanHandle | null = peer.extract(carrier);
    expect(parent?.id).toBe(dispatch.id);
    expect(parent?.traceId).toBe(dispatch.traceId);
    const turn = peer.startSpan("peer.turn", {
      parent,
      kind: "work-order-level",
      scopeId: "t1",
      agentId: "peer1",
    });
    expect(turn.traceId).toBe(run.traceId);
    expect(peer.collect()[0]?.parent_span_id).toBe(dispatch.id);
  });

  it("extract returns null for a missing or invalid traceparent", () => {
    const t = new FieldsTracer();
    expect(t.extract({})).toBeNull();
    expect(t.extract({ traceparent: "bad" })).toBeNull();
  });

  it("collect returns spans in insertion order", () => {
    const t = new FieldsTracer();
    const a = t.startSpan("run", {
      parent: null,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    t.startSpan("finalize", {
      parent: a,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    expect(t.collect().map((s) => s.name)).toEqual(["run", "finalize"]);
  });
});
