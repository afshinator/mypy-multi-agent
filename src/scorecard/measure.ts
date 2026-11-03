/**
 * One measurement for a card population (#167). A trend line and a before/after
 * table ask the same question — "what is the mean of this over the cards that
 * carry it" — so they ask it here.
 *
 * A card that does not carry the value is skipped, never counted as zero: absent
 * means "not recorded", and treating it as "none happened" would flatter every
 * card written before the metric existed.
 */
import type { RunScorecard } from "./scorecard";

export interface Measured {
  /** Cards in the population, whether or not they carry the value. */
  scorecards: number;
  /** Cards that carry it. */
  measured: number;
  sum: number;
  /** `null` when no card carries the value — a gap, not a zero. */
  mean: number | null;
}

export function measure(
  cards: readonly RunScorecard[],
  pick: (card: RunScorecard) => number | undefined,
): Measured {
  let measured = 0;
  let sum = 0;
  for (const card of cards) {
    const value = pick(card);
    if (value === undefined) continue;
    measured += 1;
    sum += value;
  }
  return { scorecards: cards.length, measured, sum, mean: measured === 0 ? null : sum / measured };
}
