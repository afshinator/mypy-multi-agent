/**
 * Pure turn pairing for run artifacts, shared by the runner and the run
 * inspector. No fs, no clock, no randomness, no mutation of inputs.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const timestampOf = (e: Record<string, unknown>): number | undefined =>
  typeof e.timestamp === "number" && Number.isFinite(e.timestamp) ? e.timestamp : undefined;

/**
 * Per-agent turn durations: a turn opens when a WORK_ORDER or PROMPT is
 * addressed to the agent and closes at its matching FINAL_REPORT or RESPONSE.
 * Opens/closes pair by identity — `correlationId` for PROMPT/RESPONSE and
 * `taskId` for WORK_ORDER/FINAL_REPORT — so overlapping turns attribute their
 * own duration instead of being zip-matched by sorted timestamp (#21). Entries
 * without an identity (e.g. pre-fix logs) are skipped rather than mispaired.
 * Durations are close-open deltas in ms; non-positive deltas are dropped.
 */
// fallow-ignore-next-line unused-export
export function turnKey(e: Record<string, unknown>): string | undefined {
  const correlationId = typeof e.correlationId === "string" ? e.correlationId : undefined;
  if (correlationId !== undefined && correlationId !== "") return `c:${correlationId}`;
  const payload = isRecord(e.payload) ? e.payload : undefined;
  const taskId = typeof e.taskId === "string" ? e.taskId : payload?.taskId;
  if (typeof taskId === "string" && taskId !== "") return `t:${taskId}`;
  return undefined;
}

export function turnDurations(
  conversation: Record<string, unknown>[],
  configuredAgents: Set<string>,
): Record<string, number[]> {
  const opens: Record<string, { key?: string; ts: number }[]> = {};
  const closes: Record<string, { key?: string; ts: number }[]> = {};
  const push = (
    map: Record<string, { key?: string; ts: number }[]>,
    agent: string,
    entry: { key?: string; ts: number },
  ): void => {
    const existing = map[agent];
    if (existing === undefined) map[agent] = [entry];
    else existing.push(entry);
  };
  for (const e of conversation) {
    const ts = timestampOf(e);
    if (ts === undefined) continue;
    if (e.type === "WORK_ORDER" || e.type === "PROMPT") {
      const target = typeof e.recipient === "string" ? e.recipient : undefined;
      if (target !== undefined && configuredAgents.has(target)) {
        push(opens, target, { key: turnKey(e), ts });
      }
    } else if (e.type === "FINAL_REPORT" || e.type === "RESPONSE") {
      const agent = typeof e.sender === "string" ? e.sender : undefined;
      if (agent !== undefined && configuredAgents.has(agent)) {
        push(closes, agent, { key: turnKey(e), ts });
      }
    }
  }
  const out: Record<string, number[]> = {};
  for (const agent of Object.keys(opens)) {
    const agentOpens = (opens[agent] ?? []).slice().sort((a, b) => a.ts - b.ts);
    const closesByKey = new Map<string, number[]>();
    for (const c of closes[agent] ?? []) {
      if (c.key === undefined) continue; // id-less close cannot pair by identity
      const list = closesByKey.get(c.key);
      if (list === undefined) closesByKey.set(c.key, [c.ts]);
      else list.push(c.ts);
    }
    const durations: number[] = [];
    for (const o of agentOpens) {
      if (o.key === undefined) continue; // id-less open cannot pair by identity
      const closeTs = closesByKey.get(o.key)?.shift();
      if (closeTs === undefined) continue; // turn never completed; no duration
      const delta = closeTs - o.ts;
      if (delta > 0) durations.push(delta);
    }
    if (durations.length > 0) out[agent] = durations;
  }
  return out;
}
