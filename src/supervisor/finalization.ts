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
 * verdict naming its criterion verbatim, and every verdict pass. A missing
 * verdict, a count mismatch, a rephrased or mismatched criterion, or a single
 * `fail` is not done (RT-8 D2: the gate checks identity, not just the count).
 */
export function criteriaSatisfied(
  verdicts: readonly CriterionVerdict[] | undefined,
  criteria: readonly string[],
): boolean {
  if (verdicts === undefined || verdicts.length !== criteria.length) return false;
  return verdicts.every((v, i) => v.result === "pass" && v.criterion === criteria[i]);
}

/** A cited artifact modified AFTER the attestation that cites it (O2). */
export interface StaleCitation {
  path: string;
  attestedAtMs: number;
  modifiedAtMs: number;
}

/**
 * Append-only run logs. An append cannot invalidate an earlier cited line and
 * changes the mtime on every frame, so staleness is meaningless for these.
 */
const APPEND_ONLY = new Set(["conversation.jsonl", "tool-calls.jsonl"]);

/** `path/to/file.ext:12-34` references in a verdict's evidence, deduped, in order. */
export function citedPaths(evidence: string): string[] {
  const out = new Set<string>();
  for (const match of evidence.matchAll(/[\w./@-]+\.[a-z]{1,6}(?::\d+(?:-\d+)?)?/gi)) {
    const path = match[0].split(":")[0];
    if (path === undefined) continue;
    if (!APPEND_ONLY.has(path.split("/").pop() ?? "")) out.add(path);
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
 * shortcut: an artifact rewritten between the reviewer's read and the attestation
 * carries an mtime older than the attestation and is not caught; the coarse case
 * (the run kept moving after the attestation) is the one that has happened.
 */
export function staleCitations(
  verdicts: readonly CriterionVerdict[],
  attestedAtMs: number,
  mtimeOf: (path: string) => number | undefined,
): StaleCitation[] {
  if (attestedAtMs <= 0) return [];
  const stale = new Map<string, StaleCitation>();
  for (const verdict of verdicts) {
    if (verdict.result !== "pass") continue;
    for (const path of citedPaths(verdict.evidence)) {
      const modifiedAtMs = mtimeOf(path);
      if (modifiedAtMs !== undefined && modifiedAtMs > attestedAtMs && !stale.has(path)) {
        stale.set(path, { path, attestedAtMs, modifiedAtMs });
      }
    }
  }
  return [...stale.values()];
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
export function finalize(
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
