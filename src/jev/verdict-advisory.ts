/**
 * Optional semantic advisory over the peer verdict block (a classifier such as
 * Jev). Advisory only: it is written to final.md and returned to the supervisor,
 * and NEVER changes the exit code — that stays with the deterministic checks in
 * `Runtime.runSucceeded`. Jev output is probabilistic (docs/jev/implementation-plan.md E2).
 */
import type { CriterionVerdict } from "../contracts/criteria";

/** P(evidence establishes criterion) in [0,1]; the classifier call seam. */
export type EstablishesEstimate = (input: {
  criterion: string;
  evidence: string;
}) => Promise<number>;

export interface CriterionAdvisory {
  criterion: string;
  /** P the evidence establishes the criterion; null when the call failed. */
  establishes: number | null;
  /** Below the threshold, or unavailable — the supervisor should look again. */
  flagged: boolean;
}

export interface VerdictAdvisory {
  model: string;
  threshold: number;
  perCriterion: CriterionAdvisory[];
  flagged: number;
}

/**
 * Judge each verdict's evidence and flag the weak ones. A failed call is flagged
 * (unknown, not a pass), never thrown — the advisory must not break finalization.
 */
export async function judgeVerdicts(
  verdicts: readonly CriterionVerdict[],
  model: string,
  threshold: number,
  estimate: EstablishesEstimate,
): Promise<VerdictAdvisory> {
  const perCriterion: CriterionAdvisory[] = [];
  for (const v of verdicts) {
    let establishes: number | null = null;
    try {
      establishes = await estimate({ criterion: v.criterion, evidence: v.evidence });
    } catch {
      establishes = null;
    }
    perCriterion.push({
      criterion: v.criterion,
      establishes,
      flagged: establishes === null || establishes < threshold,
    });
  }
  return { model, threshold, perCriterion, flagged: perCriterion.filter((c) => c.flagged).length };
}
