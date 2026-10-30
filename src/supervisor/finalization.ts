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
 * verdict naming its criterion, and every verdict pass. A missing verdict, a
 * count mismatch, a rephrased or mismatched criterion, or a single `fail` is not
 * done (RT-8 D2: the gate checks identity, not just the count).
 *
 * A verdict may label its criterion ("C1 Snapshot written ...", "CRITERION 1 —
 * Snapshot written ...") while the config line is the bare text. The label is not
 * part of the criterion, so it is stripped from both sides before the exact
 * comparison (issue #22). Label-free wording is untouched, so a rephrased
 * criterion still fails. Consumed labels: `C1`/`C1.`/`C1:` (short) and
 * `CRITERION N — ` (long, case-insensitive). A hyphen `-` is left alone so a
 * criterion that starts with `--flag` keeps its dashes; the em-dash `—` after a
 * label is consumed.
 */
const withoutCriterionLabel = (criterion: string): string =>
  criterion.replace(/^\s*(?:[A-Za-z]{1,4}\d{1,3}|criterion\s*\d{1,3})\s*[.):—]?\s*/i, "");

/**
 * Normalize a criterion before the identity comparison so transport rendering
 * differences do not fail a run whose wording is otherwise identical (issue
 * #118). Run `architecture-zones-15` failed because two DoD entries opened with
 * markdown inline-code backticks and the attester's block, carried over the
 * JSON bus, dropped them. Folding is cosmetic only — backticks, curly quotes,
 * en/em dashes and whitespace — so words and order stay exact and two
 * semantically different criteria still compare unequal.
 */
const normalizeCriterion = (criterion: string): string =>
  withoutCriterionLabel(criterion)
    .replace(/`/g, "") // markdown inline-code markers
    .replace(/["“”]/g, '"')
    .replace(/['‘’]/g, "'")
    .replace(/[–—]/g, "-") // en dash, em dash
    .replace(/\s+/g, " ")
    .trim();

/** One rejected criterion, for the gate-rejected log (issue #119). */
export interface CriteriaMismatch {
  index: number;
  expected: string;
  got: string;
  result: "pass" | "fail";
}

/** Per-index mismatches, in order. A count/absence mismatch is one entry at index -1. */
export function criteriaMismatches(
  verdicts: readonly CriterionVerdict[] | undefined,
  criteria: readonly string[],
): CriteriaMismatch[] {
  if (verdicts === undefined || verdicts.length !== criteria.length) {
    return [{ index: -1, expected: "n/a", got: "n/a", result: "fail" }];
  }
  const out: CriteriaMismatch[] = [];
  verdicts.forEach((v, i) => {
    const criterion = criteria[i];
    if (criterion === undefined) {
      out.push({ index: i, expected: "", got: v.criterion, result: v.result });
      return;
    }
    const ok =
      v.result === "pass" && normalizeCriterion(v.criterion) === normalizeCriterion(criterion);
    if (!ok) out.push({ index: i, expected: criterion, got: v.criterion, result: v.result });
  });
  return out;
}

export function criteriaSatisfied(
  verdicts: readonly CriterionVerdict[] | undefined,
  criteria: readonly string[],
): boolean {
  return criteriaMismatches(verdicts, criteria).length === 0;
}

/** One failing term of the finalize gate, named in evaluation order (issue #119). */
export interface GateTerm {
  name: "dod" | "criteria" | "stale-attestation" | "validation" | "run-contract";
  detail?: string;
}

/** The computed gate outcome, so the reply and the log can name what rejected the run. */
export interface GateResult {
  success: boolean;
  exitCode: ExitCode;
  failingTerms: GateTerm[];
}

/**
 * The five terms, in the order `gateResult` evaluates them. A bare bool loses
 * which term failed; this carries every failing term so a failed run can be
 * diagnosed from its own record rather than from a human replay.
 */
export function gateResultFromTerms(
  dodSatisfied: boolean,
  criteriaOk: boolean,
  citationsFresh: boolean,
  validationOk: boolean,
  validationCommand: string | undefined,
  contractOk: boolean,
): GateResult {
  const failingTerms: GateTerm[] = [];
  if (!dodSatisfied) failingTerms.push({ name: "dod" });
  if (!criteriaOk) failingTerms.push({ name: "criteria" });
  if (!citationsFresh) failingTerms.push({ name: "stale-attestation" });
  if (!validationOk) failingTerms.push({ name: "validation", detail: validationCommand });
  if (!contractOk) failingTerms.push({ name: "run-contract" });
  const success = failingTerms.length === 0;
  return {
    success,
    exitCode: success ? EXIT.SUCCESS : EXIT.FAILURE,
    failingTerms,
  };
}

/**
 * The finalize tool's reply, derived from the computed outcome, not the
 * supervisor's `dod` argument (issue #119: a run can write `status: failure`
 * while the tool replies `success (exit 0)`). The advisory suffix is appended
 * by the caller, which holds the advisory object.
 */
export function finalizeReplyBase(result: GateResult): string {
  const first = result.failingTerms[0];
  const gate =
    first === undefined ? "" : ` — gate: ${first.name}${first.detail ? ` (${first.detail})` : ""}`;
  return result.success
    ? `finalized: success (exit ${result.exitCode})`
    : `finalized: failure (exit ${result.exitCode})${gate}`;
}

/** A cited artifact modified AFTER the attestation that cites it (O2). */
export interface StaleCitation {
  path: string;
  attestedAtMs: number;
  modifiedAtMs: number;
  /** The attester's last read of this path, set when the rewrite landed after it. */
  readAtMs?: number;
}

/**
 * Run-written artifacts. The runtime appends or rewrites these while the run is
 * live and again at finalize — `final.md` and `findings.md` by
 * `artifacts/final-writer.ts`, `scorecard.json` by `scorecard/record.ts`,
 * `run-state.json` by `runtime/run-state.ts`, `spans.jsonl` by the tracer — so
 * their mtime is always newer than the attestation that cites them, or newer
 * than the attester's own read of them, and staleness is meaningless for them.
 *
 * Not hypothetical. Every stale-attestation this repo has recorded named only
 * files from this set: `post-mortem-01` -> spans.jsonl, `run-inspector` ->
 * run-state.json and spans.jsonl. Each was the run rejecting itself for citing a
 * log it was still writing. Keep this list in step with every writer under
 * `run-details/`; the supervisor's own artifacts (`plan.md`,
 * `findings-summary.md`) are deliberately NOT here, because it must freeze those
 * before the verdict is captured.
 */
const RUN_WRITTEN = new Set([
  "conversation.jsonl",
  "tool-calls.jsonl",
  "spans.jsonl",
  "run-state.json",
  "final.md",
  "findings.md",
  "scorecard.json",
]);

/** `path/to/file.ext:12-34` references in a verdict's evidence, deduped, in order. */
export function citedPaths(evidence: string): string[] {
  const out = new Set<string>();
  for (const match of evidence.matchAll(/[\w./@-]+\.[a-z]{1,6}(?::\d+(?:-\d+)?)?/gi)) {
    const path = match[0].split(":")[0];
    if (path === undefined) continue;
    if (!RUN_WRITTEN.has(path.split("/").pop() ?? "")) out.add(path);
  }
  return [...out];
}

/**
 * Cited artifacts whose mtime is strictly NEWER than the attestation. A verdict
 * describes the tree the reviewer read; if a file it cites changed afterwards,
 * the citation may describe a state that no longer exists. Seen twice: a verdict
 * quoting "17 waits / 1,606,136 ms" while the shipped artifact said 21 /
 * 2,051,136, and one quoting "all 30 envelope frames" against 38.
 *
 * `mtimeOf` returns undefined for a path that cannot be read — a missing locator
 * is the locator audit's job, not this check's. `attestedAtMs <= 0` means no
 * capture time was recorded, so nothing is judged.
 *
 * `readAtOf` closes the intra-read gap (issue #8): a rewrite that lands after the
 * attester read the file but before it attested carries an mtime older than the
 * attestation, so the timestamp rule above misses it. When the attester's read
 * time is known and the file is newer than that read, the citation is stale even
 * though the attestation postdates it. Without a read time, only the attestation
 * is judged.
 */
export function staleCitations(
  verdicts: readonly CriterionVerdict[],
  attestedAtMs: number,
  mtimeOf: (path: string) => number | undefined,
  readAtOf?: (path: string) => number | undefined,
): StaleCitation[] {
  if (attestedAtMs <= 0) return [];
  const stale = new Map<string, StaleCitation>();
  for (const verdict of verdicts) {
    if (verdict.result !== "pass") continue;
    for (const path of citedPaths(verdict.evidence)) {
      const modifiedAtMs = mtimeOf(path);
      if (modifiedAtMs === undefined || stale.has(path)) continue;
      const readAtMs = readAtOf?.(path);
      if (modifiedAtMs > attestedAtMs) {
        stale.set(path, { path, attestedAtMs, modifiedAtMs });
      } else if (readAtMs !== undefined && modifiedAtMs > readAtMs) {
        stale.set(path, { path, attestedAtMs, modifiedAtMs, readAtMs });
      }
    }
  }
  return [...stale.values()];
}

/**
 * The attester's read of a file in one tool-call entry, when the entry is one.
 * Only `read` calls carrying a string `args.path` and a numeric timestamp count.
 */
function readCall(
  entry: Record<string, unknown>,
  agentId: string,
): { path: string; at: number } | undefined {
  if (entry.agentId !== agentId || entry.toolName !== "read") return undefined;
  const args = entry.args;
  const path =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>).path : undefined;
  const at = entry.timestamp;
  if (typeof path !== "string" || path === "") return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return { path, at };
}

/**
 * The last time `agentId` read each path, from the tool-call log (issue #8),
 * keyed by the resolved absolute path. Other agents and other tools are skipped,
 * and a later read overwrites an earlier one.
 */
export function toolReadTimes(
  toolCalls: readonly Record<string, unknown>[],
  agentId: string,
  resolvePath: (path: string) => string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of toolCalls) {
    const call = readCall(entry, agentId);
    if (call === undefined) continue;
    const resolved = resolvePath(call.path);
    const seen = out.get(resolved);
    if (seen === undefined || call.at > seen) out.set(resolved, call.at);
  }
  return out;
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
export function buildFinalization(
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
