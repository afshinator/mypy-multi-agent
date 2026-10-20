/**
 * W3C traceparent format/parse and the span record types shared by the runner
 * and the run inspector. No node/bun imports; the app only reads spans.
 */

export type SpanName =
  | "run"
  | "finalize"
  | "validation.command"
  | "dispatch"
  | "peer.turn"
  | "tool"
  | "final_report"
  | "prompt";
export type Kind = "run-level" | "work-order-level";
export type SpanStatus = "ok" | "error" | "aborted";

export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: SpanName;
  kind: Kind;
  scope_id: string | null;
  agent_id: string | null;
  start_time: number;
  end_time: number | null;
  status: SpanStatus;
  links: Array<{ span_id: string; reason: string }>;
  operation_id?: string;
  attributes?: Record<string, unknown>;
}

export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

export function parseTraceparent(tp: string): { traceId: string; spanId: string } | null {
  const parts = tp.split("-");
  if (parts.length !== 4) return null;
  const version = parts[0];
  const traceId = parts[1];
  const spanId = parts[2];
  if (version !== "00" || traceId === undefined || spanId === undefined) return null;
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) return null;
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return null;
  return { traceId, spanId };
}
