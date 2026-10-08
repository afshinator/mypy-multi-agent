/**
 * Maps the supervisor's Definition-of-Done verdict to the final artifact outcome
 * and exit code.
 */
import type { CriterionVerdict } from "../contracts/criteria";
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
  totalCostUsd: number;
  totalTokens: number;
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
}

/**
 * "Done" requires exactly one verdict per DoD criterion and every verdict pass.
 * A missing verdict, a count mismatch, or a single `fail` is not done.
 */
export function criteriaSatisfied(
  verdicts: readonly CriterionVerdict[] | undefined,
  criteria: readonly string[],
): boolean {
  if (verdicts === undefined || verdicts.length !== criteria.length) return false;
  return verdicts.every((v) => v.result === "pass");
}

/** Map captured FINAL_REPORTs to the reconciliation shape used by final.md. */
function finalReports(reconciliation: Reconciliation): FinalReport[] {
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
): Finalization {
  return {
    outcome: dodSatisfied ? "success" : "failure",
    exitCode: dodSatisfied ? EXIT.SUCCESS : EXIT.FAILURE,
    reports: finalReports(reconciliation),
    decision,
    criteria,
  };
}
