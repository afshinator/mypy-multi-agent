import { parseJsonl } from "../../shared/parse-jsonl";
import type { SpanName, SpanRecord } from "../../shared/traceparent";
import type { DirReader } from "./reader";

export interface SpanTree {
  span: SpanRecord;
  children: SpanTree[];
}

export interface WaterfallRow {
  span: SpanRecord;
  depth: number;
  durationMs: number;
  startOffsetMs: number;
}

export interface SpanTrace {
  spans: SpanRecord[];
  roots: SpanTree[];
  waterfall: WaterfallRow[];
  minStartMs: number;
  maxEndMs: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function toSpan(e: Record<string, unknown>): SpanRecord | null {
  const spanId = str(e.span_id);
  const start = num(e.start_time);
  if (spanId === undefined || start === undefined) return null;
  return {
    trace_id: str(e.trace_id) ?? "",
    span_id: spanId,
    parent_span_id: str(e.parent_span_id) ?? null,
    name: (str(e.name) ?? "run") as SpanName,
    kind: e.kind === "run-level" ? "run-level" : "work-order-level",
    scope_id: str(e.scope_id) ?? null,
    agent_id: str(e.agent_id) ?? null,
    start_time: start,
    end_time: num(e.end_time) ?? null,
    status: e.status === "error" ? "error" : e.status === "aborted" ? "aborted" : "ok",
    links: Array.isArray(e.links) ? (e.links as SpanRecord["links"]) : [],
    operation_id: str(e.operation_id),
    attributes: isRecord(e.attributes) ? e.attributes : undefined,
  };
}

/** Build a nested span tree by parent_span_id; orphans become roots. */
export function buildSpanTree(spans: SpanRecord[]): SpanTree[] {
  const byParent = new Map<string, SpanRecord[]>();
  for (const span of spans) {
    const parent = span.parent_span_id ?? "";
    const list = byParent.get(parent);
    if (list === undefined) byParent.set(parent, [span]);
    else list.push(span);
  }
  const childrenOf = (parentId: string): SpanTree[] =>
    (byParent.get(parentId) ?? []).map((span) => ({ span, children: childrenOf(span.span_id) }));
  const ids = new Set(spans.map((s) => s.span_id));
  const roots = spans.filter((s) => s.parent_span_id === null || !ids.has(s.parent_span_id));
  return roots.map((span) => ({ span, children: childrenOf(span.span_id) }));
}

/** Depth-annotated waterfall rows from a span tree. */
export function buildWaterfall(roots: SpanTree[], minStartMs: number): WaterfallRow[] {
  const rows: WaterfallRow[] = [];
  const walk = (node: SpanTree, depth: number): void => {
    const span = node.span;
    rows.push({
      span,
      depth,
      durationMs: span.end_time === null ? 0 : span.end_time - span.start_time,
      startOffsetMs: span.start_time - minStartMs,
    });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return rows;
}

/** Build the typed span-trace aggregate from spans.jsonl text. */
export function buildSpanTrace(text: string): SpanTrace {
  const spans = parseJsonl(text)
    .map(toSpan)
    .filter((s): s is SpanRecord => s !== null)
    .sort((a, b) => a.start_time - b.start_time);
  const minStartMs = spans.length === 0 ? 0 : Math.min(...spans.map((s) => s.start_time));
  const maxEndMs =
    spans.length === 0 ? 0 : Math.max(...spans.map((s) => s.end_time ?? s.start_time));
  const roots = buildSpanTree(spans);
  return { spans, roots, waterfall: buildWaterfall(roots, minStartMs), minStartMs, maxEndMs };
}

/** Load a task's spans.jsonl; null when the artifact is absent. */
export async function loadSpanTrace(
  reader: DirReader,
  runDetailsPath: string,
): Promise<SpanTrace | null> {
  const spans = await reader.readText(`${runDetailsPath}/spans.jsonl`);
  return spans === null ? null : buildSpanTrace(spans.text);
}
