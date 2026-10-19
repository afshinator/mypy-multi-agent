/**
 * Fields-only tracing (D6): OTel-compatible ids, W3C traceparent propagation,
 * and a span store keyed by span_id — no SDK dependency. Ported from
 * scripts/bun-s4-probe/{core.ts,strategies.ts} FieldsOnly.
 */
import { randomBytes } from "node:crypto";

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

export interface SpanHandle {
  /** span_id */
  id: string;
  /** trace_id this span belongs to; set on startSpan for cross-process use. */
  traceId?: string;
  /** extract() handle: no local span record exists. */
  remote?: boolean;
}

export interface StartOpts {
  parent: SpanHandle | null;
  kind: Kind;
  scopeId: string | null;
  agentId: string | null;
  operationId?: string;
  attrs?: Record<string, unknown>;
}

export interface Tracing {
  startSpan(name: SpanName, opts: StartOpts): SpanHandle;
  endSpan(h: SpanHandle, status?: SpanStatus): void;
  inject(env: Record<string, unknown>, h: SpanHandle): void;
  extract(env: Record<string, unknown>): SpanHandle | null;
  collect(): SpanRecord[];
}

export const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

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

export interface FieldsTracerOptions {
  now?: () => number;
  /** Additive span-log sink, called once per completed span. */
  sink?: (record: SpanRecord) => void;
}

export class FieldsTracer implements Tracing {
  private readonly traceId = randomHex(16);
  private readonly spans = new Map<string, SpanRecord>();
  private readonly now: () => number;
  private readonly sink: ((record: SpanRecord) => void) | undefined;

  constructor(opts: FieldsTracerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sink = opts.sink;
  }

  startSpan(name: SpanName, opts: StartOpts): SpanHandle {
    const spanId = randomHex(8);
    // D6 fix: inherit trace_id from the parent handle, never mint a fresh one.
    const traceId = opts.parent?.traceId ?? this.traceId;
    const record: SpanRecord = {
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: opts.parent ? opts.parent.id : null,
      name,
      kind: opts.kind,
      scope_id: opts.scopeId,
      agent_id: opts.agentId,
      start_time: this.now(),
      end_time: null,
      status: "ok",
      links: [],
      ...(opts.operationId !== undefined ? { operation_id: opts.operationId } : {}),
      ...(opts.attrs !== undefined ? { attributes: opts.attrs } : {}),
    };
    this.spans.set(spanId, record);
    return { id: spanId, traceId };
  }

  endSpan(h: SpanHandle, status: SpanStatus = "ok"): void {
    // Map lookup by span_id, not an Array.find scan. Idempotent so an abort close
    // is never overwritten by a later end (e.g. a tool event racing turn abort).
    const s = this.spans.get(h.id);
    if (s && s.end_time === null) {
      s.end_time = this.now();
      s.status = status;
      this.sink?.(s);
    }
  }

  inject(env: Record<string, unknown>, h: SpanHandle): void {
    env.traceparent = formatTraceparent(h.traceId ?? this.traceId, h.id);
  }

  extract(env: Record<string, unknown>): SpanHandle | null {
    const tp = env.traceparent;
    if (typeof tp !== "string") return null;
    const parsed = parseTraceparent(tp);
    if (!parsed) return null;
    return { id: parsed.spanId, traceId: parsed.traceId, remote: true };
  }

  collect(): SpanRecord[] {
    return [...this.spans.values()];
  }
}
