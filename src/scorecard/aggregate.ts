/**
 * Pure cross-project aggregation (issue #19): ranks mistake classes across
 * scorecards by frequency and rate. No fs, no clock, no randomness, no mutation
 * of inputs. Mixed-vintage scorecards are grouped by taxonomyVersion and never
 * compared across versions (issue #13's "never silently compare" rule).
 */
import type { RunScorecard } from "./scorecard";

export interface MistakeTrend {
  class: string;
  count: number;
  /** count / number of scorecards in the same taxonomyVersion group. */
  rate: number;
}

export interface VersionTrends {
  taxonomyVersion: string;
  scorecardCount: number;
  /** Sorted worst-first by count, then by class for a deterministic tie-break. */
  mistakes: MistakeTrend[];
  /**
   * Attestation re-work over the cards that carry the metric. Null when no card
   * in the group does: an absent metric is not two rounds, and averaging a
   * default would invent data.
   */
  attestation: { cards: number; meanRounds: number; firstRoundFailed: number } | null;
}

export interface Trends {
  scorecardCount: number;
  byVersion: VersionTrends[];
}

export function aggregate(scorecards: readonly RunScorecard[]): Trends {
  const groups = new Map<string, RunScorecard[]>();
  for (const sc of scorecards) {
    const group = groups.get(sc.taxonomyVersion);
    if (group === undefined) groups.set(sc.taxonomyVersion, [sc]);
    else group.push(sc);
  }

  const byVersion: VersionTrends[] = [];
  for (const [taxonomyVersion, cards] of groups) {
    const counts = new Map<string, number>();
    for (const card of cards) {
      for (const mistake of card.mistakes) {
        counts.set(mistake.class, (counts.get(mistake.class) ?? 0) + 1);
      }
    }
    const mistakes = [...counts.entries()]
      .map(([cls, count]) => ({ class: cls, count, rate: count / cards.length }))
      .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
    const measured = cards.filter((c) => c.attestationRounds !== undefined);
    const rounds = measured.reduce((sum, c) => sum + (c.attestationRounds ?? 0), 0);
    const attestation =
      measured.length === 0
        ? null
        : {
            cards: measured.length,
            meanRounds: rounds / measured.length,
            firstRoundFailed: measured.filter((c) => c.firstAttestationRoundFailed === true).length,
          };
    byVersion.push({ taxonomyVersion, scorecardCount: cards.length, mistakes, attestation });
  }

  byVersion.sort((a, b) => a.taxonomyVersion.localeCompare(b.taxonomyVersion));
  return { scorecardCount: scorecards.length, byVersion };
}
