/**
 * Pure per-run health scorecard: derives a fixed RunScorecard from already-parsed
 * artifacts (conversation entries, tool-call entries, final frontmatter) and the
 * session config. No fs, no clock, no randomness, no mutation of inputs.
 *
 * Privacy boundary (issue #14): the output is derived metrics only. Prompts,
 * reports, system prompts, tool arguments, decision text and criteria evidence
 * are never copied into the scorecard.
 */
import type { CriterionVerdict } from "../contracts/criteria";
import type { SessionConfig } from "../contracts/session-schema";
import { criteriaSatisfied } from "../supervisor/finalization";

/** Version stamped on every scorecard so mixed-vintage scorecards never silently compare. */
export const TAXONOMY_VERSION = "1.0";

export type ConversationEntry = Record<string, unknown>;
export type ToolCallEntry = Record<string, unknown>;

/** Already-parsed final.md frontmatter (status/exit_code/cost lines). */
export interface ScorecardFinal {
  outcome: string | null;
  exitCode: number | null;
  totalCostUsd: number | null;
  totalTokens: number | null;
  supervisorCostUsd: number | null;
  supervisorTokens: number | null;
  agentCosts: { name: string; costUsd: number; tokens: number }[];
}

export interface ScorecardArtifacts {
  conversation: ConversationEntry[];
  toolCalls: ToolCallEntry[];
  final: ScorecardFinal;
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
  dod: "met" | "unmet" | "unknown";
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
}

const finiteNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const timestampOf = (e: ConversationEntry): number | undefined =>
  typeof e.timestamp === "number" && Number.isFinite(e.timestamp) ? e.timestamp : undefined;

/** Fixed STOP_AGENT reason codes emitted by the runtime; anything else is "other". */
const STOP_AGENT_REASON_CODES = new Set([
  "user",
  "supervisor",
  "budget threshold",
  "heartbeat timeout",
  "protocol fault",
  "empty model output",
]);

const normalizeStopReason = (reason: unknown): string =>
  typeof reason === "string" && STOP_AGENT_REASON_CODES.has(reason) ? reason : "other";

/** final.md frontmatter status must be one of three known outcomes; foreign values are "unknown". */
const normalizeOutcome = (outcome: string | null): string | null =>
  outcome === null || outcome === "success" || outcome === "failure" || outcome === "aborted"
    ? outcome
    : "unknown";

/**
 * Per-agent turn durations: a turn opens when a WORK_ORDER or PROMPT is
 * addressed to the agent and closes at its next FINAL_REPORT or RESPONSE.
 * Durations are close-open deltas in ms; non-positive deltas are dropped.
 */
function turnDurations(
  conversation: ConversationEntry[],
  configuredAgents: Set<string>,
): Record<string, number[]> {
  // shortcut: pairs opens/closes by sorted timestamp per agent because conversation.jsonl has no correlationId; upgrade if interleaved concurrent turns become common.
  const opens: Record<string, number[]> = {};
  const closes: Record<string, number[]> = {};
  const push = (map: Record<string, number[]>, key: string, ts: number): void => {
    const existing = map[key];
    if (existing === undefined) map[key] = [ts];
    else existing.push(ts);
  };
  for (const e of conversation) {
    const ts = timestampOf(e);
    if (ts === undefined) continue;
    if (e.type === "WORK_ORDER" || e.type === "PROMPT") {
      const target = typeof e.recipient === "string" ? e.recipient : undefined;
      if (target !== undefined && configuredAgents.has(target)) push(opens, target, ts);
    } else if (e.type === "FINAL_REPORT" || e.type === "RESPONSE") {
      const agent = typeof e.sender === "string" ? e.sender : undefined;
      if (agent !== undefined && configuredAgents.has(agent)) push(closes, agent, ts);
    }
  }
  const out: Record<string, number[]> = {};
  for (const agent of Object.keys(opens)) {
    const o = opens[agent];
    if (o === undefined) continue;
    const sortedO = o.slice().sort((a, b) => a - b);
    const sortedC = (closes[agent] ?? []).slice().sort((a, b) => a - b);
    const durations: number[] = [];
    const limit = Math.min(sortedO.length, sortedC.length);
    for (let i = 0; i < limit; i++) {
      const openTs = sortedO[i];
      const closeTs = sortedC[i];
      if (openTs === undefined || closeTs === undefined) continue;
      const delta = closeTs - openTs;
      if (delta > 0) durations.push(delta);
    }
    if (durations.length > 0) out[agent] = durations;
  }
  return out;
}

/** Latest non-empty attester verdict block in the conversation (mirrors the finalize gate). */
function attestedVerdicts(
  conversation: ConversationEntry[],
  attester: string,
): CriterionVerdict[] | undefined {
  let latest: CriterionVerdict[] | undefined;
  for (const e of conversation) {
    if (e.type !== "RESPONSE" && e.type !== "FINAL_REPORT") continue;
    if (e.sender !== attester) continue;
    if (!isRecord(e.payload)) continue;
    const criteria = e.payload.criteria;
    if (!Array.isArray(criteria) || criteria.length === 0) continue;
    latest = criteria as CriterionVerdict[];
  }
  return latest;
}

export function buildScorecard(artifacts: ScorecardArtifacts, config: SessionConfig): RunScorecard {
  const { conversation, toolCalls, final } = artifacts;
  const outcome = normalizeOutcome(final.outcome);
  const exitCode = finiteNum(final.exitCode);
  const configuredAgents = new Set(config.agents.map((a) => a.id));

  const verdicts = attestedVerdicts(conversation, config.session.attester);
  const dod: RunScorecard["dod"] =
    verdicts === undefined
      ? "unknown"
      : criteriaSatisfied(verdicts, config.ask.definition_of_done)
        ? "met"
        : "unmet";

  let toolTimeMs = 0;
  let toolCallCount = 0;
  let toolErrors = 0;
  const toolTimeByAgentMs: Record<string, number> = {};
  for (const t of toolCalls) {
    toolCallCount++;
    if (t.isError === true) toolErrors++;
    const duration = finiteNum(t.durationMs);
    if (duration === null || duration < 0) continue;
    toolTimeMs += duration;
    if (typeof t.agentId === "string" && configuredAgents.has(t.agentId)) {
      toolTimeByAgentMs[t.agentId] = (toolTimeByAgentMs[t.agentId] ?? 0) + duration;
    }
  }

  let retries = 0;
  let correlationTimeouts = 0;
  let agentCrashed = 0;
  let agentUnusable = 0;
  let agentStalled = 0;
  const stopAgentReasons: Record<string, number> = {};
  for (const e of conversation) {
    if (e.type === "RETRY") retries++;
    else if (e.type === "ERROR" && e.event === "correlation-timeout") correlationTimeouts++;
    else if (e.type === "AGENT_CRASHED") agentCrashed++;
    else if (e.type === "AGENT_UNUSABLE") agentUnusable++;
    else if (e.type === "AGENT_STALLED") agentStalled++;
    if (e.type === "STOP_AGENT") {
      const reason = normalizeStopReason(isRecord(e.payload) ? e.payload.reason : undefined);
      stopAgentReasons[reason] = (stopAgentReasons[reason] ?? 0) + 1;
    }
  }

  const successOutcome = outcome === "success";
  const successExit = exitCode === 0;

  return {
    taxonomyVersion: TAXONOMY_VERSION,
    outcome,
    exitCode,
    outcomeExitMismatch: outcome !== null && exitCode !== null && successOutcome !== successExit,
    dod,
    falseSuccess: exitCode === 0 && dod === "unmet",
    turnDurationsMs: turnDurations(conversation, configuredAgents),
    toolTimeMs,
    toolTimeByAgentMs,
    toolCalls: toolCallCount,
    toolErrors,
    retries,
    correlationTimeouts,
    agentCrashed,
    agentUnusable,
    agentStalled,
    stopAgentReasons,
    cost: {
      totalCostUsd: finiteNum(final.totalCostUsd),
      totalTokens: finiteNum(final.totalTokens),
      supervisorCostUsd: finiteNum(final.supervisorCostUsd),
      supervisorTokens: finiteNum(final.supervisorTokens),
      agents: final.agentCosts
        .filter((a) => configuredAgents.has(a.name))
        .map((a) => ({
          agentId: a.name,
          costUsd: a.costUsd,
          tokens: a.tokens,
        })),
    },
    modelRoster: [...new Set(config.agents.map((a) => a.model))],
  };
}
