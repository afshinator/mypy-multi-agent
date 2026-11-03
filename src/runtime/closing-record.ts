/**
 * The run's closing record (#163): one owner for the sequence that ends a run.
 *
 * The order is the invariant, and it used to be implicit in Runtime.finalize:
 * `recordScorecard` re-reads the `final.md` this module writes, so the scorecard
 * must come after it, and the run-state snapshot must come last so it carries the
 * supervisor's usage. Swapping any two calls used to be a silent, plausible edit.
 */
import type { VerdictAdvisory } from "../jev/verdict-advisory";
import type { CostBreakdown, FinalSummary, GateResult } from "../supervisor/finalization";

export interface ClosingRecordDeps {
  /** Two phases: decide, then persist. A failed write never completes a session. */
  gate: {
    evaluate: (
      dodSatisfied: boolean,
      decision: string | undefined,
      summary: FinalSummary | undefined,
      advisory: VerdictAdvisory | undefined,
    ) => Promise<GateResult>;
    write: (costs: CostBreakdown) => Promise<void>;
  };
  costBreakdown: (supervisorUsage?: SupervisorUsage) => CostBreakdown;
  /** Opt-in via `session.record_scorecard`; absent means the run asked for none. */
  scorecard?: () => Promise<void>;
  writeSnapshot: (supervisorUsage?: SupervisorUsage) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
}

export interface SupervisorUsage {
  costUsd: number;
  tokens: number;
}

export interface ClosingRecordInput {
  dodSatisfied: boolean;
  decision?: string;
  summary?: FinalSummary;
  advisory?: VerdictAdvisory;
  supervisorUsage?: SupervisorUsage;
}

export async function closeRun(
  deps: ClosingRecordDeps,
  input: ClosingRecordInput,
): Promise<GateResult> {
  const result = await deps.gate.evaluate(
    input.dodSatisfied,
    input.decision,
    input.summary,
    input.advisory,
  );
  // final.md first: the scorecard reads it back off disk.
  await deps.gate.write(deps.costBreakdown(input.supervisorUsage));
  if (deps.scorecard !== undefined) {
    // Additive only: a failed card must not change the outcome or fail the run.
    try {
      await deps.scorecard();
    } catch (err) {
      deps.log({
        type: "ERROR",
        timestamp: Date.now(),
        event: "scorecard-write-failed",
        message: (err as Error).message,
      });
    }
  }
  // Last: the snapshot reports the run's own totals, supervisor usage included.
  await deps.writeSnapshot(input.supervisorUsage);
  return result;
}
