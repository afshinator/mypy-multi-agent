import type { DirReader } from "./reader";

/**
 * Web-local mirror of the run health scorecard (`scorecard.json`). The
 * runner-side type in `src/scorecard/scorecard.ts` imports node-side
 * contracts, so the viewer keeps its own minimal, JSON-faithful shape.
 */
export interface ScorecardMistake {
  class: string;
  detail: string;
}

export interface AgentCostLine {
  agentId: string;
  costUsd: number;
  tokens: number;
}

export interface RunScorecard {
  taxonomyVersion: string;
  outcome: string | null;
  exitCode: number | null;
  outcomeExitMismatch: boolean;
  dod: string;
  falseSuccess: boolean;
  turnDurationsMs: Record<string, number[]>;
  toolTimeMs: number;
  toolTimeByAgentMs: Record<string, number>;
  toolCalls: number;
  toolErrors: number;
  retries: number;
  correlationTimeouts: number;
  agentCrashed: number;
  agentUnusable: number;
  agentStalled: number;
  stopAgentReasons: Record<string, number>;
  cost: {
    totalCostUsd: number | null;
    totalTokens: number | null;
    supervisorCostUsd: number | null;
    supervisorTokens: number | null;
    agents: AgentCostLine[];
  };
  modelRoster: string[];
  mistakes: ScorecardMistake[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function numRecord(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!isNum(value)) return null;
    out[key] = value;
  }
  return out;
}

function numArrayRecord(v: unknown): Record<string, number[]> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!Array.isArray(value) || !value.every(isNum)) return null;
    out[key] = value;
  }
  return out;
}

const numOrNull = (v: unknown): number | null | undefined =>
  v === null ? null : isNum(v) ? v : undefined;

function parseCost(v: unknown): RunScorecard["cost"] | null {
  if (!isRecord(v)) return null;
  const totalCostUsd = numOrNull(v.totalCostUsd);
  const totalTokens = numOrNull(v.totalTokens);
  const supervisorCostUsd = numOrNull(v.supervisorCostUsd);
  const supervisorTokens = numOrNull(v.supervisorTokens);
  if (
    totalCostUsd === undefined ||
    totalTokens === undefined ||
    supervisorCostUsd === undefined ||
    supervisorTokens === undefined ||
    !Array.isArray(v.agents)
  ) {
    return null;
  }
  const agents: AgentCostLine[] = [];
  for (const item of v.agents) {
    if (!isRecord(item) || !isStr(item.agentId) || !isNum(item.costUsd) || !isNum(item.tokens)) {
      return null;
    }
    agents.push({ agentId: item.agentId, costUsd: item.costUsd, tokens: item.tokens });
  }
  return { totalCostUsd, totalTokens, supervisorCostUsd, supervisorTokens, agents };
}

/** Parse scorecard.json text; null on invalid JSON or missing required fields. */
export function parseScorecard(text: string): RunScorecard | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const taxonomyVersion = isStr(parsed.taxonomyVersion) ? parsed.taxonomyVersion : null;
  const outcome =
    parsed.outcome === null ? null : isStr(parsed.outcome) ? parsed.outcome : undefined;
  const exitCode =
    parsed.exitCode === null ? null : isNum(parsed.exitCode) ? parsed.exitCode : undefined;
  const outcomeExitMismatch = isBool(parsed.outcomeExitMismatch)
    ? parsed.outcomeExitMismatch
    : null;
  const dod = isStr(parsed.dod) ? parsed.dod : null;
  const falseSuccess = isBool(parsed.falseSuccess) ? parsed.falseSuccess : null;
  const turnDurationsMs = numArrayRecord(parsed.turnDurationsMs);
  const toolTimeMs = isNum(parsed.toolTimeMs) ? parsed.toolTimeMs : null;
  const toolTimeByAgentMs = numRecord(parsed.toolTimeByAgentMs);
  const toolCalls = isNum(parsed.toolCalls) ? parsed.toolCalls : null;
  const toolErrors = isNum(parsed.toolErrors) ? parsed.toolErrors : null;
  const retries = isNum(parsed.retries) ? parsed.retries : null;
  const correlationTimeouts = isNum(parsed.correlationTimeouts) ? parsed.correlationTimeouts : null;
  const agentCrashed = isNum(parsed.agentCrashed) ? parsed.agentCrashed : null;
  const agentUnusable = isNum(parsed.agentUnusable) ? parsed.agentUnusable : null;
  const agentStalled = isNum(parsed.agentStalled) ? parsed.agentStalled : null;
  const stopAgentReasons = numRecord(parsed.stopAgentReasons);
  const cost = parseCost(parsed.cost);
  const modelRoster =
    Array.isArray(parsed.modelRoster) && parsed.modelRoster.every(isStr)
      ? [...parsed.modelRoster]
      : null;
  const mistakesRaw = Array.isArray(parsed.mistakes) ? parsed.mistakes : null;

  const invalid =
    [
      taxonomyVersion,
      outcomeExitMismatch,
      dod,
      falseSuccess,
      turnDurationsMs,
      toolTimeMs,
      toolTimeByAgentMs,
      toolCalls,
      toolErrors,
      retries,
      correlationTimeouts,
      agentCrashed,
      agentUnusable,
      agentStalled,
      stopAgentReasons,
      cost,
      modelRoster,
      mistakesRaw,
    ].some((v) => v === null) ||
    outcome === undefined ||
    exitCode === undefined;
  if (invalid) return null;

  const mistakes: ScorecardMistake[] = [];
  for (const mistake of mistakesRaw as unknown[]) {
    if (!isRecord(mistake) || !isStr(mistake.class) || !isStr(mistake.detail)) return null;
    mistakes.push({ class: mistake.class, detail: mistake.detail });
  }

  return {
    taxonomyVersion: taxonomyVersion as string,
    outcome: outcome as string | null,
    exitCode: exitCode as number | null,
    outcomeExitMismatch: outcomeExitMismatch as boolean,
    dod: dod as string,
    falseSuccess: falseSuccess as boolean,
    turnDurationsMs: turnDurationsMs as Record<string, number[]>,
    toolTimeMs: toolTimeMs as number,
    toolTimeByAgentMs: toolTimeByAgentMs as Record<string, number>,
    toolCalls: toolCalls as number,
    toolErrors: toolErrors as number,
    retries: retries as number,
    correlationTimeouts: correlationTimeouts as number,
    agentCrashed: agentCrashed as number,
    agentUnusable: agentUnusable as number,
    agentStalled: agentStalled as number,
    stopAgentReasons: stopAgentReasons as Record<string, number>,
    cost: cost as RunScorecard["cost"],
    modelRoster: modelRoster as string[],
    mistakes,
  };
}

/** Load a task's scorecard.json; null when the artifact is absent or invalid. */
export async function loadScorecard(
  reader: DirReader,
  runDetailsPath: string,
): Promise<RunScorecard | null> {
  const file = await reader.readText(`${runDetailsPath}/scorecard.json`);
  return file === null ? null : parseScorecard(file.text);
}
