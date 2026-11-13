/**
 * Renders one paid call's arrival-stamped events as a human-readable timing trace.
 *
 * The raw pi stream carries `durationMs` per tool but no wall-clock per line, so
 * `runAgent` stamps each event's arrival time as it reads stdout; this module turns
 * those stamps into the two facts a reader wants: how long each tool took, and how
 * long the call sat *between* tools. A gap is never rendered as nothing: the line
 * that follows it frames it.
 */

export interface TraceEvent {
  /** Arrival time in ms since the call's start. */
  atMs: number;
  kind: "turn" | "tool";
  /** The completed turn's number, on `turn` events. */
  turn?: number;
  tool?: string;
  detail?: string;
  /** Provider-reported tool duration, on `tool` events. */
  durationMs?: number;
}

export interface TraceSummary {
  costUsd: number;
  turns: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Wall time of the whole call in ms. */
  wallMs: number;
}

/** Gaps below this are noise between back-to-back tool calls and are folded away. */
const GAP_MS = 500;

function sec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function stamp(atMs: number): string {
  return `${sec(atMs)}`.padStart(7, " ");
}

export function renderTrace(events: readonly TraceEvent[], summary: TraceSummary): string {
  const lines: string[] = [];
  let prevAtMs = 0;
  let toolMs = 0;
  for (const e of events) {
    if (e.kind === "turn") {
      lines.push(`${stamp(e.atMs)}  turn ${e.turn} ends`);
      prevAtMs = e.atMs;
      continue;
    }
    const gap = e.atMs - prevAtMs;
    if (gap >= GAP_MS) lines.push(`${stamp(e.atMs)}  · gap ${sec(gap)}`);
    const dur = e.durationMs === undefined ? "" : ` · ${e.durationMs}ms`;
    lines.push(`${stamp(e.atMs)}  ${e.tool ?? "tool"}  ${e.detail ?? ""}${dur}`);
    if (e.durationMs !== undefined) toolMs += e.durationMs;
    prevAtMs = e.atMs;
  }
  const tokens =
    summary.inputTokens === undefined
      ? ""
      : ` · ${summary.inputTokens + (summary.outputTokens ?? 0)} tokens`;
  lines.push(
    `done — wall ${sec(summary.wallMs)} · tools ${sec(toolMs)} · ${summary.turns} turns · $${summary.costUsd.toFixed(4)}${tokens}`,
  );
  return lines.join("\n");
}
