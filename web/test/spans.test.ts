import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSpanTrace } from "../lib/spans";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("buildSpanTrace", () => {
  it("sorts spans by start_time and roots the tree by parent_span_id", () => {
    const trace = buildSpanTrace(fixture("spans-trimmed.jsonl"));
    expect(trace.spans.map((s) => s.span_id)).toEqual([
      "root1",
      "prompt1",
      "turn1",
      "tool1",
      "tool2",
      "fin1",
      "orphan1",
    ]);
    expect(trace.roots.map((r) => r.span.span_id)).toEqual(["root1", "orphan1"]);
    expect(trace.roots[0]?.children.map((c) => c.span.span_id)).toEqual(["prompt1", "fin1"]);
  });

  it("annotates waterfall rows with depth, duration, and start offset", () => {
    const trace = buildSpanTrace(fixture("spans-trimmed.jsonl"));
    expect(trace.waterfall.map((w) => [w.span.span_id, w.depth])).toEqual([
      ["root1", 0],
      ["prompt1", 1],
      ["turn1", 2],
      ["tool1", 3],
      ["tool2", 3],
      ["fin1", 1],
      ["orphan1", 0],
    ]);
    expect(trace.waterfall.find((w) => w.span.span_id === "turn1")?.durationMs).toBe(2800);
    expect(trace.waterfall.find((w) => w.span.span_id === "orphan1")?.startOffsetMs).toBe(7000);
    expect(trace.minStartMs).toBe(1000);
    expect(trace.maxEndMs).toBe(10000);
  });

  it("treats a null end_time as zero duration", () => {
    const text =
      '{"trace_id":"t","span_id":"a","parent_span_id":null,"name":"run","kind":"run-level","scope_id":null,"agent_id":null,"start_time":10,"end_time":null,"status":"ok","links":[]}\n';
    const trace = buildSpanTrace(text);
    expect(trace.waterfall[0]?.durationMs).toBe(0);
    expect(trace.maxEndMs).toBe(10);
  });
});
