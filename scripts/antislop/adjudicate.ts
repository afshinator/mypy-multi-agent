/**
 * Adjudication contract: one verdict per finding, on three independent dimensions.
 *
 * Validity answers "is the reported condition genuinely present?". Actionability
 * answers "would changing it materially improve the code?". Consequence answers
 * "what does leaving it alone cost?". They are recorded separately because the
 * pilot conflated them: ~75% of findings were valid and ~22% were actionable, and
 * a single "verified" count could express neither.
 *
 * Aggregation is per (tool, rule family), never per tool: the pilot's fallow
 * numbers only made sense once `crap` (0/5) was separated from `unused_exports`
 * (2/2). Families below MIN_FAMILY_SAMPLE are marked `anecdote`, not reported as
 * a rate.
 */
import { z } from "zod";
import { ACTIONABILITY, CONSEQUENCE, type Finding, MIN_FAMILY_SAMPLE, VALIDITY } from "./schema";

export const VerdictSchema = z.strictObject({
  id: z.string().min(1),
  by: z.string().min(1),
  method: z.string().min(1),
  evidence_ref: z.string().min(1),
  /** What was read, in one sentence. A verdict without a reading is an opinion. */
  reason: z.string().min(1),
  validity: z.enum(VALIDITY),
  actionability: z.enum(ACTIONABILITY),
  consequence: z.enum(CONSEQUENCE),
});

export type Verdict = z.infer<typeof VerdictSchema>;
export type Counts = Record<(typeof VALIDITY)[number], number>;

export interface FamilyRow {
  tool: string;
  rule_id: string | null;
  sampled: number;
  validity: Counts;
  /** Only `present` findings are actionable, so these three sum to validity.present. */
  actionability: Record<"material" | "marginal" | "none", number>;
  consequence: Record<"high" | "medium" | "low" | "none", number>;
  anecdote: boolean;
}

const LEGACY_VALIDITY: Record<string, (typeof VALIDITY)[number]> = {
  unreviewed: "unreviewed",
  verified: "present",
  false_positive: "absent",
  duplicate: "duplicate",
  inconclusive: "undecidable",
};

const zero = <T extends string>(keys: readonly T[]): Record<T, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;

export const emptyCounts = (): Counts => zero(VALIDITY);

/**
 * Accepts the pilot's four-value vocabulary (`status`) and lifts it onto the three
 * dimensions. Legacy rows cannot know actionability or consequence, so those become
 * `not_applicable` — which is why legacy and current rows must not be pooled.
 */
export function normalizeVerdict(raw: unknown): Verdict {
  if (typeof raw !== "object" || raw === null) throw new Error("verdict is not an object");
  const row = raw as Record<string, unknown>;
  const explicit = typeof row.validity === "string" ? row.validity : undefined;
  const legacy = typeof row.status === "string" ? LEGACY_VALIDITY[row.status] : undefined;
  const validity = explicit ?? legacy;
  if (validity === undefined) {
    throw new Error(`verdict ${String(row.id)} has neither a validity nor a known status`);
  }
  const applicable = validity === "present";
  return VerdictSchema.parse({
    id: row.id,
    by: row.by,
    method: row.method,
    evidence_ref: row.evidence_ref,
    reason: row.reason ?? row.method,
    validity,
    actionability: row.actionability ?? (applicable ? undefined : "not_applicable"),
    consequence: row.consequence ?? (applicable ? undefined : "not_applicable"),
  });
}

/** Dimension rules the enums cannot express: only a present condition can be worth fixing. */
export function dimensionProblems(verdict: Verdict): string[] {
  const { id, validity, actionability, consequence } = verdict;
  const applicability = [actionability, consequence];
  if (validity === "present") {
    return applicability.includes("not_applicable")
      ? [`${id}: validity present requires an actionability and a consequence`]
      : [];
  }
  return applicability.every((x) => x === "not_applicable")
    ? []
    : [`${id}: validity ${validity} cannot be actionable — both dimensions must be not_applicable`];
}

/** Per (tool, rule family) counts across the three dimensions. */
export function aggregateFamilies(findings: Finding[], verdicts: Verdict[]): FamilyRow[] {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const rows = new Map<string, FamilyRow>();
  for (const finding of findings) {
    const verdict = byId.get(finding.id);
    if (verdict === undefined) continue;
    const key = `${finding.primary_tool}\u0000${finding.rule_id ?? ""}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        tool: finding.primary_tool,
        rule_id: finding.rule_id,
        sampled: 0,
        validity: emptyCounts(),
        actionability: zero(["material", "marginal", "none"] as const),
        consequence: zero(["high", "medium", "low", "none"] as const),
        anecdote: false,
      };
      rows.set(key, row);
    }
    row.sampled += 1;
    row.validity[verdict.validity] += 1;
    if (verdict.validity === "present") {
      if (verdict.actionability === "material" || verdict.actionability === "marginal") {
        row.actionability[verdict.actionability] += 1;
      } else {
        row.actionability.none += 1;
      }
      if (verdict.consequence !== "not_applicable") row.consequence[verdict.consequence] += 1;
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, anecdote: row.sampled < MIN_FAMILY_SAMPLE }))
    .sort(
      (a, b) => a.tool.localeCompare(b.tool) || (a.rule_id ?? "").localeCompare(b.rule_id ?? ""),
    );
}

export interface MergeResult {
  findings: Finding[];
  counts: Counts;
  byFamily: FamilyRow[];
  problems: string[];
  merged: number;
}

/** Merge verdicts into findings, recompute counts, and report every contract break. */
export function mergeVerdicts(
  findings: Finding[],
  verdicts: Verdict[],
  checkedAt: string,
): MergeResult {
  const problems: string[] = [];
  const known = new Set(findings.map((f) => f.id));
  const byId = new Map<string, Verdict>();
  for (const verdict of verdicts) {
    if (!known.has(verdict.id)) problems.push(`verdict for unknown finding: ${verdict.id}`);
    if (byId.has(verdict.id)) problems.push(`duplicate verdict for finding: ${verdict.id}`);
    problems.push(...dimensionProblems(verdict));
    byId.set(verdict.id, verdict);
  }
  const counts = emptyCounts();
  let merged = 0;
  const updated = findings.map((finding): Finding => {
    const verdict = byId.get(finding.id);
    if (verdict === undefined) {
      counts.unreviewed += 1;
      return finding;
    }
    merged += 1;
    counts[verdict.validity] += 1;
    return {
      ...finding,
      verification: {
        validity: verdict.validity,
        actionability: verdict.actionability,
        consequence: verdict.consequence,
        by: verdict.by,
        method: verdict.method,
        evidence_ref: verdict.evidence_ref,
        checked_at: checkedAt,
      },
    };
  });
  return {
    findings: updated,
    counts,
    byFamily: aggregateFamilies(updated, verdicts),
    problems,
    merged,
  };
}

/** Verified-but-useless is the pilot's dominant failure mode; this is its number. */
export function actionabilityShare(rows: FamilyRow[]): number | null {
  const present = rows.reduce((n, r) => n + r.validity.present, 0);
  if (present === 0) return null;
  const material = rows.reduce((n, r) => n + r.actionability.material, 0);
  return material / present;
}
