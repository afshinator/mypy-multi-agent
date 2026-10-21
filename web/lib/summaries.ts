import type { SpanTrace } from "./spans";
import type { Timeline } from "./timeline";
import type { ToolCall } from "./tool-calls";

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function summarizeTimeline(timeline: Timeline | null): string {
  if (timeline === null || timeline.events.length === 0) return "No conversation recorded";
  return `${timeline.events.length} events · ${timeline.actors.length} agents`;
}

export function summarizeToolCalls(calls: ToolCall[] | null): string {
  if (calls === null || calls.length === 0) return "No tool calls";
  const errors = calls.filter((call) => call.isError).length;
  return `${calls.length} calls · ${errors} ${errors === 1 ? "error" : "errors"}`;
}

export function summarizeTrace(trace: SpanTrace | null): string {
  if (trace === null || trace.spans.length === 0) return "No spans recorded";
  // Real peers only: spans without an agent_id are the run/system level.
  const agents = new Set(
    trace.spans.map((s) => s.agent_id).filter((id): id is string => id !== null),
  ).size;
  return `${trace.spans.length} spans · ${agents} agents · total duration ${formatDuration(
    trace.maxEndMs - trace.minStartMs,
  )}`;
}
