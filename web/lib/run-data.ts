import { parseFrontmatter } from "./frontmatter";
import type { DirReader } from "./reader";

export interface AgentCost {
  name: string;
  costUsd: number;
  tokens: number;
}

export interface RunSummary {
  outcome: string;
  exitCode?: number;
  totalCostUsd?: number;
  totalTokens?: number;
  supervisorCostUsd?: number;
  supervisorTokens?: number;
  agents: AgentCost[];
}

export interface DoDCriterion {
  pass: boolean;
  criterion: string;
  evidence: string;
}

/** The one typed aggregate views and charts consume; never raw file text. */
export interface RunData {
  summary: RunSummary;
  criteria: DoDCriterion[];
  /** final.md was present (primary source for summary and criteria). */
  hasFinalMd: boolean;
  /** At least one summary source (final.md/scorecard.json/run-state.json) was present. */
  hasSummary: boolean;
}

export interface RunArtifacts {
  finalMd?: string;
  scorecardJson?: string;
  runStateJson?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function parseJson(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseAgents(v: unknown): AgentCost[] {
  return flatAgents(v, "name", "cost_usd", "tokens");
}

function flatAgents(
  items: unknown,
  nameKey: string,
  costKey: string,
  tokensKey: string,
): AgentCost[] {
  if (!Array.isArray(items)) return [];
  const out: AgentCost[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const name = typeof item[nameKey] === "string" ? item[nameKey] : undefined;
    const costUsd = num(item[costKey]);
    const tokens = num(item[tokensKey]);
    if (name === undefined || costUsd === undefined || tokens === undefined) continue;
    out.push({ name, costUsd, tokens });
  }
  return out;
}

function runStateAgents(v: unknown): AgentCost[] {
  if (!Array.isArray(v)) return [];
  const out: AgentCost[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const name = typeof item.id === "string" ? item.id : undefined;
    const usage = isRecord(item.usage) ? item.usage : undefined;
    const costUsd = usage !== undefined ? num(usage.costUsd) : undefined;
    const tokens = usage !== undefined ? num(usage.tokens) : undefined;
    if (name === undefined || costUsd === undefined || tokens === undefined) continue;
    out.push({ name, costUsd, tokens });
  }
  return out;
}

/** Parse `## Criteria` checklist lines into typed verdicts. */
export function parseCriteria(finalMd: string): DoDCriterion[] {
  const section = /^## Criteria\n([\s\S]*?)(?=\n## |(?![\s\S]))/m.exec(finalMd)?.[1];
  if (section === undefined) return [];
  const out: DoDCriterion[] = [];
  for (const raw of section.split("\n")) {
    const m = /^- \[(x| )\] (.+)$/.exec(raw.trim());
    if (m === null) continue;
    const rest = m[2] ?? "";
    const sep = rest.indexOf(" — ");
    out.push({
      pass: m[1] === "x",
      criterion: (sep === -1 ? rest : rest.slice(0, sep)).trim(),
      evidence: sep === -1 ? "" : rest.slice(sep + 3).trim(),
    });
  }
  return out;
}

/**
 * Build the RunData aggregate from parsed artifacts. Summary fields resolve
 * from final.md frontmatter -> scorecard.json -> run-state.json.
 */
export function buildRunData(artifacts: RunArtifacts): RunData {
  const fm = parseFrontmatter(artifacts.finalMd ?? "");
  const scorecard = parseJson(artifacts.scorecardJson);
  const runState = parseJson(artifacts.runStateJson);
  const scorecardCost = isRecord(scorecard.cost) ? scorecard.cost : undefined;
  const runStateTotals = isRecord(runState.totals) ? runState.totals : undefined;

  const summary: RunSummary = {
    outcome:
      (typeof fm.status === "string" ? fm.status : undefined) ??
      (typeof scorecard.outcome === "string" ? scorecard.outcome : undefined) ??
      "unknown",
    agents: parseAgents(fm.agents),
  };

  if (summary.agents.length === 0 && scorecardCost !== undefined) {
    summary.agents = flatAgents(scorecardCost.agents, "agentId", "costUsd", "tokens");
  }
  if (summary.agents.length === 0) {
    summary.agents = runStateAgents(runState.agents);
  }

  const exitCode = num(fm.exit_code) ?? num(scorecard.exitCode);
  if (exitCode !== undefined) summary.exitCode = exitCode;

  const totalCostUsd =
    num(fm.total_cost_usd) ??
    (scorecardCost !== undefined ? num(scorecardCost.totalCostUsd) : undefined) ??
    (runStateTotals !== undefined ? num(runStateTotals.costUsd) : undefined);
  if (totalCostUsd !== undefined) summary.totalCostUsd = totalCostUsd;

  const totalTokens =
    num(fm.total_tokens) ??
    (scorecardCost !== undefined ? num(scorecardCost.totalTokens) : undefined) ??
    (runStateTotals !== undefined ? num(runStateTotals.tokens) : undefined);
  if (totalTokens !== undefined) summary.totalTokens = totalTokens;

  const supervisorCostUsd =
    num(fm.supervisor_cost_usd) ??
    (scorecardCost !== undefined ? num(scorecardCost.supervisorCostUsd) : undefined);
  if (supervisorCostUsd !== undefined) summary.supervisorCostUsd = supervisorCostUsd;

  const supervisorTokens =
    num(fm.supervisor_tokens) ??
    (scorecardCost !== undefined ? num(scorecardCost.supervisorTokens) : undefined);
  if (supervisorTokens !== undefined) summary.supervisorTokens = supervisorTokens;

  return {
    summary,
    criteria: parseCriteria(artifacts.finalMd ?? ""),
    hasFinalMd: artifacts.finalMd !== undefined,
    hasSummary:
      artifacts.finalMd !== undefined ||
      artifacts.scorecardJson !== undefined ||
      artifacts.runStateJson !== undefined,
  };
}

/** Load a task's artifacts through the reader and build the aggregate. */
export async function loadRunData(reader: DirReader, runDetailsPath: string): Promise<RunData> {
  const [finalMd, scorecardJson, runStateJson] = await Promise.all([
    reader.readText(`${runDetailsPath}/final.md`),
    reader.readText(`${runDetailsPath}/scorecard.json`),
    reader.readText(`${runDetailsPath}/run-state.json`),
  ]);
  return buildRunData({
    finalMd: finalMd?.text,
    scorecardJson: scorecardJson?.text,
    runStateJson: runStateJson?.text,
  });
}
