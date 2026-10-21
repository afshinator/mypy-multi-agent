import { describe, expect, it } from "vitest";
import type { SpanTrace } from "../lib/spans";
import { summarizeTimeline, summarizeToolCalls, summarizeTrace } from "../lib/summaries";
import type { Timeline, TimelineEvent } from "../lib/timeline";
import type { ToolCall } from "../lib/tool-calls";

const event = (i: number): TimelineEvent => ({
  timestamp: i,
  type: "PROMPT",
  sender: "supervisor",
  recipient: "dev_a",
  isOpen: false,
  isClose: false,
});

const timeline = (count: number, actorCount: number): Timeline => ({
  events: Array.from({ length: count }, (_, i) => event(i)),
  durationsByAgent: {},
  actors: Array.from({ length: actorCount }, (_, i) => `dev_${i}`),
  types: ["PROMPT"],
});

const call = (isError: boolean): ToolCall => ({
  timestamp: 0,
  agentId: "a",
  toolName: "read",
  argsText: "{}",
  isError,
});

const span = (id: string, agentId: string | null, start: number, end: number) => ({
  trace_id: "t",
  span_id: id,
  parent_span_id: id === "root" ? null : "root",
  name: id === "root" ? ("run" as const) : ("dispatch" as const),
  kind: id === "root" ? ("run-level" as const) : ("work-order-level" as const),
  scope_id: null,
  agent_id: agentId,
  start_time: start,
  end_time: end,
  status: "ok" as const,
  links: [],
});

const trace = (): SpanTrace => ({
  spans: [
    span("root", null, 1000, 9000),
    span("w1", "dev_a", 1200, 5000),
    span("w2", "dev_b", 5200, 8800),
  ],
  roots: [],
  waterfall: [],
  minStartMs: 1000,
  maxEndMs: 9000,
});

describe("summaries", () => {
  it("summarizeTimeline: null, empty, and counts", () => {
    expect(summarizeTimeline(null)).toBe("No conversation recorded");
    expect(summarizeTimeline(timeline(0, 0))).toBe("No conversation recorded");
    expect(summarizeTimeline(timeline(4, 2))).toBe("4 events · 2 agents");
  });

  it("summarizeToolCalls: null, empty, and error counts", () => {
    expect(summarizeToolCalls(null)).toBe("No tool calls");
    expect(summarizeToolCalls([])).toBe("No tool calls");
    expect(summarizeToolCalls([call(false), call(true), call(false)])).toBe("3 calls · 1 error");
    expect(summarizeToolCalls([call(true), call(true)])).toBe("2 calls · 2 errors");
  });

  it("summarizeTrace: null, empty, and counts", () => {
    expect(summarizeTrace(null)).toBe("No spans recorded");
    expect(
      summarizeTrace({ spans: [], roots: [], waterfall: [], minStartMs: 0, maxEndMs: 0 }),
    ).toBe("No spans recorded");
    expect(summarizeTrace(trace())).toBe("3 spans · 2 agents · total duration 8.0s");
  });
});
