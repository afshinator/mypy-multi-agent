/**
 * Verification sampling.
 *
 * Strata are keyed by (tool, rule family), not by category: knip reports `files`,
 * `exports`, `types`, and `binaries` under one category, and a category-keyed sample
 * silently skipped its only unique class. Every family gets a floor before any large
 * family is topped up, so a small unique class cannot be starved by a noisy one.
 */
import { type Finding, mulberry32 } from "./schema";

export const SAMPLE_CAP = 80;
const MIN_PER_STRATUM = 5;

/**
 * Collapse a tool's rule id to a family that a human would call one kind of finding.
 *
 *   biome `lint/style/noNonNullAssertion` -> `lint/style`
 *   oxlint `unicorn(no-useless-spread)`   -> `unicorn`
 *   aislop `ai-slop/double-type-assertion`-> `ai-slop`
 *   knip   `exports`                      -> `exports`
 *   jscpd  `exact`                        -> `exact`
 */
export function ruleFamily(ruleId: string | null): string {
  if (ruleId === null || ruleId === "") return "unknown";
  const paren = ruleId.indexOf("(");
  if (paren > 0) return ruleId.slice(0, paren);
  const slash = ruleId.lastIndexOf("/");
  if (slash > 0) return ruleId.slice(0, slash);
  return ruleId;
}

export type Stratum = { key: string; frame: number; sampled: number; ids: string[] };

/**
 * Deterministic allocation. Order of operations matters:
 *   1. every family is floored at `min(5, frame)`, smallest families first, so a rare
 *      unique class is never outbid by a noisy one;
 *   2. remaining budget tops families up toward 10% of their frame, largest first;
 *   3. the cap is enforced without ever cutting a family below its floor.
 */
export function pickSample(
  findings: Finding[],
  seed: number,
  cap: number = SAMPLE_CAP,
): { strata: Stratum[]; ids: string[] } {
  const buckets = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = `${finding.primary_tool}/${ruleFamily(finding.rule_id)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [finding]);
    else bucket.push(finding);
  }

  const random = mulberry32(seed);
  const shuffle = (list: Finding[]): Finding[] => {
    const copy = [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const a = copy[i];
      const b = copy[j];
      if (a !== undefined && b !== undefined) {
        copy[i] = b;
        copy[j] = a;
      }
    }
    return copy;
  };

  const ordered = [...buckets.entries()]
    .map(([key, list]) => ({ key, list: shuffle(list) }))
    .sort((a, b) =>
      a.list.length === b.list.length ? (a.key < b.key ? -1 : 1) : a.list.length - b.list.length,
    );

  const take = new Map<string, number>();
  let total = 0;
  // Pass 0 — visibility: one sample per family, so no class is ever entirely unmeasured.
  for (const { key } of ordered) {
    if (total >= cap) break;
    take.set(key, 1);
    total += 1;
  }
  // Pass 1 — floors, smallest families first: a rare unique class outranks a noisy one.
  for (const { key, list } of ordered) {
    const floor = Math.min(MIN_PER_STRATUM, list.length);
    while ((take.get(key) ?? 0) < floor && total < cap) {
      take.set(key, (take.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  // Pass 2 — top up toward 10% of frame, largest families first, with whatever is left.
  for (const { key, list } of [...ordered].sort((a, b) => b.list.length - a.list.length)) {
    const target = Math.min(Math.max(MIN_PER_STRATUM, Math.ceil(list.length * 0.1)), list.length);
    while ((take.get(key) ?? 0) < target && total < cap) {
      take.set(key, (take.get(key) ?? 0) + 1);
      total += 1;
    }
  }

  const strata: Stratum[] = [];
  for (const { key, list } of ordered) {
    const wanted = take.get(key) ?? 0;
    strata.push({
      key,
      frame: list.length,
      sampled: wanted,
      ids: list.slice(0, wanted).map((f) => f.id),
    });
  }
  return {
    ids: strata.flatMap((s) => s.ids),
    strata: strata.sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}
