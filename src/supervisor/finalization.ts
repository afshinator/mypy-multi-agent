/**
 * Maps the supervisor's Definition-of-Done verdict to the final artifact outcome
 * and exit code.
 */
import type { CriterionVerdict } from "../contracts/criteria";
import type { VerdictAdvisory } from "../jev/verdict-advisory";
import { EXIT, type ExitCode } from "../runtime/exit";
import type { Reconciliation } from "./reconciliation";

export interface FinalReport {
  agentId: string;
  report: string;
}

export interface AgentCost {
  name: string;
  costUsd: number;
  tokens: number;
}

export interface CostBreakdown {
  supervisorCostUsd: number;
  supervisorTokens: number;
  agents: AgentCost[];
  /** Ids of agents whose model has no catalog price; their dollars are an estimate (RT-2). */
  unpricedAgents?: string[];
  totalCostUsd: number;
  totalTokens: number;
}

export interface FinalSummary {
  accomplished: string[];
  left: string[];
}

export interface Finalization {
  outcome: "success" | "failure" | "aborted";
  exitCode: ExitCode;
  reports: FinalReport[];
  /** Supervisor's decision record (tensions, reviewer input, final calls). Written into final.md. */
  decision?: string;
  /** One pass/fail verdict per DoD criterion. Written into final.md. */
  criteria?: CriterionVerdict[];
  costs?: CostBreakdown;
  /** Reader-facing overview (accomplished / left). Written into final.md's ## Summary. */
  summary?: FinalSummary;
  /** Optional semantic advisory over the verdicts (never affects the exit code). */
  advisory?: VerdictAdvisory;
}

/**
 * "Done" requires exactly one verdict per DoD criterion, in config order, each
 * verdict naming its criterion verbatim, and every verdict pass. A missing
 * verdict, a count mismatch, a rephrased or mismatched criterion, or a single
 * `fail` is not done (RT-8 D2: the gate checks identity, not just the count).
 */
export function criteriaSatisfied(
  verdicts: readonly CriterionVerdict[] | undefined,
  criteria: readonly string[],
): boolean {
  if (verdicts === undefined || verdicts.length !== criteria.length) return false;
  return verdicts.every((v, i) => v.result === "pass" && v.criterion === criteria[i]);
}

/** Map captured FINAL_REPORTs to the reconciliation shape used by final.md. */
function finalReports(reconciliation: Reconciliation): FinalReport[] {
  // payload casts are safe: FINAL_REPORT is zod strictObject-validated at the
  // bus (a2a-schema.ts) and only valid envelopes are captured.
  return [...reconciliation.reports().values()].map((env) => ({
    agentId: (env.payload as { agentId: string }).agentId,
    report: (env.payload as { report: string }).report,
  }));
}

/** DoD evaluation is the supervisor's semantic job; this maps it to exit 0/1. */
export function finalize(
  reconciliation: Reconciliation,
  dodSatisfied: boolean,
  decision?: string,
  criteria?: CriterionVerdict[],
  summary?: FinalSummary,
  advisory?: VerdictAdvisory,
): Finalization {
  return {
    outcome: dodSatisfied ? "success" : "failure",
    exitCode: dodSatisfied ? EXIT.SUCCESS : EXIT.FAILURE,
    reports: finalReports(reconciliation),
    decision,
    criteria,
    summary,
    advisory,
  };
}
