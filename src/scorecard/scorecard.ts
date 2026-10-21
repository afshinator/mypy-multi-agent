/**
 * Pure per-run health scorecard: derives a fixed RunScorecard from already-parsed
 * artifacts (conversation entries, tool-call entries, final frontmatter) and the
 * session config. No fs, no clock, no randomness, no mutation of inputs.
 *
 * Privacy boundary (issue #14): the output is derived metrics only. Prompts,
 * reports, system prompts, tool arguments, decision text and criteria evidence
 * are never copied into the scorecard.
 */
import { turnDurations } from "../../shared/turn";
import type { CriterionVerdict } from "../contracts/criteria";
import type { SessionConfig } from "../contracts/session-schema";
import { criteriaSatisfied } from "../supervisor/finalization";
import { classifyMistakes, type Mistake } from "./mistakes";

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
  /** Issue #18: post-run mistake classes (M1-M3) derived from the fields above. */
  mistakes: Mistake[];
}

const finiteNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

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
export const normalizeOutcome = (outcome: string | null): string | null =>
  outcome === null || outcome === "success" || outcome === "failure" || outcome === "aborted"
    ? outcome
    : "unknown";

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
  // buildScorecard is only called for standard-role runs; analysis roles don't generate scorecards
  const agents = config.agents ?? [];
  const configuredAgents = new Set(agents.map((a: (typeof agents)[number]) => a.id));

  const verdicts = attestedVerdicts(conversation, config.session.attester);
  const ask = config.ask;
  const dod: RunScorecard["dod"] =
    verdicts === undefined
      ? "unknown"
      : ask === undefined
        ? "unknown"
        : criteriaSatisfied(verdicts, ask.definition_of_done)
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
  const outcomeExitMismatch =
    outcome !== null && exitCode !== null && successOutcome !== successExit;
  const falseSuccess = exitCode === 0 && dod === "unmet";
  const turnDurationsMs = turnDurations(conversation, configuredAgents);
  const mistakes = classifyMistakes(
    {
      outcome,
      exitCode,
      outcomeExitMismatch,
      dod,
      falseSuccess,
      turnDurationsMs,
      agentStalled,
      correlationTimeouts,
    },
    config,
  );

  return {
    taxonomyVersion: TAXONOMY_VERSION,
    outcome,
    exitCode,
    outcomeExitMismatch,
    dod,
    falseSuccess,
    turnDurationsMs,
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
    modelRoster: [...new Set(agents.map((a) => a.model))],
    mistakes,
  };
}
