/**
 * Report contract for a read-only anti-slop audit run.
 *
 * Two datasets, deliberately separate: `findings` holds deterministic analyzer
 * output only; `instruction_reviews` holds model-judged reviews with no stable
 * ids. Anything that cannot be recomputed from a raw artifact does not belong in
 * `findings`.
 */
import { z } from "zod";

export const STATUS = [
  "executed",
  "clean",
  "success_with_findings",
  "failure",
  "timeout",
  "blocked",
  "unsupported",
  "not_installed",
  "deferred",
] as const;

export const CATEGORY = [
  "unused_file_export_dep",
  "dead_code_inline",
  "duplication",
  "dependency_cycle_boundary",
  "architecture",
  "lint_correctness",
  "lint_style",
  "type_error",
  "complexity",
  "ai_pattern",
  "other",
] as const;

export const SEVERITY = ["error", "warning", "info", "unknown"] as const;

/** Dimension 1: is the reported condition genuinely present? */
export const VALIDITY = ["unreviewed", "present", "absent", "duplicate", "undecidable"] as const;

/** Dimension 2: would changing it materially improve the code? */
export const ACTIONABILITY = ["material", "marginal", "none", "not_applicable"] as const;

/** Dimension 3: what does leaving it alone cost? */
export const CONSEQUENCE = ["high", "medium", "low", "none", "not_applicable"] as const;

/** Below this many adjudications a family is reported as an anecdote, never as a rate. */
export const MIN_FAMILY_SAMPLE = 5;

export const FindingSchema = z.strictObject({
  id: z.string().min(1),
  tools: z.array(z.string().min(1)).min(1),
  primary_tool: z.string().min(1),
  rule_id: z.string().nullable(),
  category: z.enum(CATEGORY),
  severity: z.enum(SEVERITY),
  path: z.string().min(1),
  line: z.number().int().nonnegative().nullable(),
  message: z.string(),
  dedupe_key: z.string().min(1),
  verification: z.strictObject({
    validity: z.enum(VALIDITY),
    actionability: z.enum(ACTIONABILITY),
    consequence: z.enum(CONSEQUENCE),
    by: z.string().nullable(),
    method: z.string().nullable(),
    evidence_ref: z.string().nullable(),
    checked_at: z.string().nullable(),
  }),
  provenance: z.strictObject({
    tool_id: z.string().min(1),
    tool_version: z.string().min(1),
    raw_output: z.string().min(1),
    /** Where inside the raw artifact this finding came from, when a JSON pointer applies. */
    json_pointer: z.string().nullable(),
    invocation_index: z.number().int().nonnegative(),
  }),
});

export const ToolRunSchema = z.strictObject({
  id: z.string().min(1),
  cohort: z.enum(["existing", "new"]),
  version: z.string().min(1),
  status: z.enum(STATUS),
  /** Null when the tool never ran. */
  exit_code: z.number().int().nullable(),
  expected_nonzero_exit: z.boolean(),
  timed_out: z.boolean(),
  elapsed_ms: z.number().int().nonnegative().nullable(),
  argv: z.array(z.string()),
  raw: z.strictObject({ stdout: z.string().nullable(), stderr: z.string().nullable() }),
  output_format: z.enum(["json", "text"]),
  finding_count: z.number().int().nonnegative(),
  deterministic: z.boolean(),
  writes_to_tree: z.boolean(),
  /** Required whenever status is not executed/clean/success_with_findings. */
  reason: z.string().nullable(),
});

export const AuditSchema = z.strictObject({
  schema_version: z.literal("0.3"),
  run: z.strictObject({
    id: z.string().min(1),
    started_at: z.string().min(1),
    finished_at: z.string().min(1),
    scan_root: z.string().min(1),
    output_root: z.string().min(1),
    commit: z.string().nullable(),
    git_status_clean_before: z.boolean(),
    tree_unchanged: z.boolean(),
    host: z.strictObject({ os: z.string(), arch: z.string(), bun: z.string() }),
    toolchain_manifest_sha256: z.string().min(1),
  }),
  scope: z.strictObject({
    included: z.array(z.string()),
    excluded: z.array(z.string()),
  }),
  /** One entry per declared delta: a path prefix a known write trap produces. */
  declared_deltas: z.array(
    z.strictObject({ path: z.string().min(1), observed: z.boolean(), owner: z.string() }),
  ),
  undeclared_deltas: z.array(z.string()),
  tools: z.array(ToolRunSchema),
  findings: z.array(FindingSchema),
  instruction_reviews: z.array(
    z.strictObject({
      id: z.string().min(1),
      method: z.enum(["unguided", "ponytail_guided", "deterministic_grep"]),
      model: z.string().nullable(),
      skill_revision: z.string().nullable(),
      prompt_sha256: z.string().nullable(),
      raw_output: z.string().nullable(),
      finding_count: z.number().int().nonnegative(),
    }),
  ),
  verification: z.strictObject({
    sampling: z.strictObject({
      method: z.literal("stratified"),
      seed: z.number().int(),
      frame_size: z.number().int().nonnegative(),
      strata: z.array(
        z.strictObject({
          key: z.string().min(1),
          frame: z.number().int().nonnegative(),
          sampled: z.number().int().nonnegative(),
        }),
      ),
    }),
    counts: z.strictObject({
      unreviewed: z.number().int().nonnegative(),
      present: z.number().int().nonnegative(),
      absent: z.number().int().nonnegative(),
      duplicate: z.number().int().nonnegative(),
      undecidable: z.number().int().nonnegative(),
    }),
    /** The three dimensions per (tool, rule family) — the unit decisions are made on. */
    by_family: z.array(
      z.strictObject({
        tool: z.string().min(1),
        rule_id: z.string().nullable(),
        sampled: z.number().int().nonnegative(),
        validity: z.strictObject({
          unreviewed: z.number().int().nonnegative(),
          present: z.number().int().nonnegative(),
          absent: z.number().int().nonnegative(),
          duplicate: z.number().int().nonnegative(),
          undecidable: z.number().int().nonnegative(),
        }),
        actionability: z.strictObject({
          material: z.number().int().nonnegative(),
          marginal: z.number().int().nonnegative(),
          none: z.number().int().nonnegative(),
        }),
        consequence: z.strictObject({
          high: z.number().int().nonnegative(),
          medium: z.number().int().nonnegative(),
          low: z.number().int().nonnegative(),
          none: z.number().int().nonnegative(),
        }),
        /** True when sampled < MIN_FAMILY_SAMPLE. */
        anecdote: z.boolean(),
      }),
    ),
    caveats: z.array(z.string()),
  }),
  limitations: z.array(z.string()),
});

export type Finding = z.infer<typeof FindingSchema>;
export type ToolRun = z.infer<typeof ToolRunSchema>;
export type Audit = z.infer<typeof AuditSchema>;

/** Populated per finding: `path:line_bucket:category`, so near-duplicates collapse. */
export const dedupeKey = (path: string, line: number | null, category: string): string =>
  `${path}:${Math.floor((line ?? 0) / 4)}:${category}`;

/** Deterministic PRNG so the stratified sample is reproducible from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
