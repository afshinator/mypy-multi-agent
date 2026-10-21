import type { SpanRecord } from "../../shared/traceparent";
import { buildSpanTree, type SpanTree } from "./spans";

export type ConversationRecord = Record<string, unknown>;

export interface CriticalPath {
  spanIds: string[];
  durationMs: number;
}

export interface AgentIdle {
  wallMs: number;
  activeMs: number;
  idleMs: number;
}

export interface TraceAnalysis {
  criticalPath: CriticalPath | null;
  parallelismFactor: number | null;
  agentIdleTime: Record<string, AgentIdle>;
  supervisorLatency: number[];
}

const durationOf = (span: SpanRecord): number =>
  span.end_time === null ? 0 : span.end_time - span.start_time;

const tsOf = (e: ConversationRecord): number | undefined =>
  typeof e.timestamp === "number" && Number.isFinite(e.timestamp) ? e.timestamp : undefined;

/**
 * Longest parent->child span chain, root to leaf. Chain duration is the sum of
 * each span's (end_time - start_time); a null end_time counts as zero. Ties
 * break lexicographically on the joined span ids for determinism.
 */
export function criticalPath(spans: SpanRecord[]): CriticalPath | null {
  if (spans.length === 0) return null;
  const roots = buildSpanTree(spans);
  let best: CriticalPath | null = null;

  const walk = (node: SpanTree, ids: string[], total: number): void => {
    const nextIds = [...ids, node.span.span_id];
    const nextTotal = total + durationOf(node.span);
    if (node.children.length === 0) {
      if (
        best === null ||
        nextTotal > best.durationMs ||
        (nextTotal === best.durationMs && nextIds.join("|") < best.spanIds.join("|"))
      ) {
        best = { spanIds: nextIds, durationMs: nextTotal };
      }
      return;
    }
    for (const child of node.children) walk(child, nextIds, nextTotal);
  };

  for (const root of roots) walk(root, [], 0);
  return best;
}

/** Sum of span durations divided by wall clock (maxEnd - minStart). */
export function parallelismFactor(spans: SpanRecord[]): number | null {
  if (spans.length === 0) return null;
  const minStart = Math.min(...spans.map((s) => s.start_time));
  const maxEnd = Math.max(...spans.map((s) => s.end_time ?? s.start_time));
  const wallMs = maxEnd - minStart;
  if (wallMs <= 0) return null;
  const total = spans.reduce((acc, span) => acc + durationOf(span), 0);
  return total / wallMs;
}

/**
 * Per-agent idle time: wall (last report/response - first dispatch) minus the
 * agent's active span time. Agents without spans or a completed wall are
 * skipped; idle is never negative.
 */
export function agentIdleTime(
  spans: SpanRecord[],
  conversation: ConversationRecord[],
): Record<string, AgentIdle> {
  const agentIds = new Set(spans.map((s) => s.agent_id).filter((id): id is string => id !== null));
  const activeByAgent: Record<string, number> = {};
  for (const span of spans) {
    if (span.agent_id === null) continue;
    activeByAgent[span.agent_id] = (activeByAgent[span.agent_id] ?? 0) + durationOf(span);
  }

  const firstOpen: Record<string, number> = {};
  const lastClose: Record<string, number> = {};
  for (const e of conversation) {
    const ts = tsOf(e);
    if (ts === undefined) continue;
    if (e.type === "WORK_ORDER" || e.type === "PROMPT") {
      const agent = typeof e.recipient === "string" ? e.recipient : undefined;
      if (agent !== undefined && agentIds.has(agent)) {
        firstOpen[agent] = firstOpen[agent] === undefined ? ts : Math.min(firstOpen[agent], ts);
      }
    } else if (e.type === "FINAL_REPORT" || e.type === "RESPONSE") {
      const agent = typeof e.sender === "string" ? e.sender : undefined;
      if (agent !== undefined && agentIds.has(agent)) {
        lastClose[agent] = lastClose[agent] === undefined ? ts : Math.max(lastClose[agent], ts);
      }
    }
  }

  const out: Record<string, AgentIdle> = {};
  for (const agent of [...agentIds].sort()) {
    const open = firstOpen[agent];
    const close = lastClose[agent];
    if (open === undefined || close === undefined) continue;
    const activeMs = activeByAgent[agent] ?? 0;
    const wallMs = close - open;
    out[agent] = { wallMs, activeMs, idleMs: Math.max(0, wallMs - activeMs) };
  }
  return out;
}

/** Gap (ms) from each FINAL_REPORT to the next WORK_ORDER after it. */
export function supervisorLatency(conversation: ConversationRecord[]): number[] {
  const sorted = conversation
    .map((e) => ({ type: typeof e.type === "string" ? e.type : "", ts: tsOf(e) ?? 0 }))
    .sort((a, b) => a.ts - b.ts);
  const gaps: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const report = sorted[i];
    if (report?.type !== "FINAL_REPORT") continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const next = sorted[j];
      if (next?.type === "WORK_ORDER") {
        gaps.push(next.ts - report.ts);
        break;
      }
    }
  }
  return gaps;
}

/** Compute the full trace-analysis aggregate from spans and conversation. */
export function analyzeTrace(
  spans: SpanRecord[],
  conversation: ConversationRecord[],
): TraceAnalysis {
  return {
    criticalPath: criticalPath(spans),
    parallelismFactor: parallelismFactor(spans),
    agentIdleTime: agentIdleTime(spans, conversation),
    supervisorLatency: supervisorLatency(conversation),
  };
}
