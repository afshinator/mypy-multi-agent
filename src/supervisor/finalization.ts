/**
 * Maps the supervisor's Definition-of-Done verdict to the final artifact outcome
 * and exit code.
 */
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
  costs?: CostBreakdown;
}

/** DoD evaluation is the supervisor's semantic job; this maps it to exit 0/1. */
export function finalize(reconciliation: Reconciliation, dodSatisfied: boolean): Finalization {
  const reports: FinalReport[] = [...reconciliation.reports().values()].map((env) => ({
    agentId: (env.payload as { agentId: string }).agentId,
    report: (env.payload as { report: string }).report,
  }));
  return {
    outcome: dodSatisfied ? "success" : "failure",
    exitCode: dodSatisfied ? EXIT.SUCCESS : EXIT.FAILURE,
    reports,
  };
}
