/**
 * The audit's contract checks, as a function over data (#169).
 *
 * `verify.ts` used to be the gate and its own process: it read `audit.json` off
 * disk and called `process.exit` at five sites, so no test could reach the checks
 * without reproducing a whole audit. They live here now, taking the audit, the
 * sample and the verdicts as values; the CLI reads, calls, prints and exits.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { mergeVerdicts, normalizeVerdict, type Verdict } from "./adjudicate";
import { type Audit, dedupeKey } from "./schema";

/** Did the tool actually run? One statement of the predicate both callers use. */
export function isExecuted(tool: Pick<Audit["tools"][number], "status">): boolean {
  return tool.status === "clean" || tool.status === "success_with_findings";
}

export interface AuditSample {
  finding_ids: string[];
  strata: { sampled: number }[];
}

export interface VerifyInput {
  /** The directory holding audit.json, sample.json and the raw evidence. */
  dir: string;
}

export interface VerifyOutcome {
  problems: string[];
  merged: Audit;
  mergedCount: number;
}

/**
 * Every contract problem with `audit`, plus the audit with any verifier verdicts
 * merged in. A verdict file present on disk is used; its evidence must exist.
 */
export function verifyAudit(audit: Audit, input: VerifyInput): VerifyOutcome {
  const { dir } = input;
  const problems: string[] = [];
  const exists = (rel: string | null): boolean => rel !== null && existsSync(join(dir, rel));

  // 1. Every executed tool kept its raw evidence; an unexecuted one said why.
  for (const tool of audit.tools) {
    if (isExecuted(tool)) {
      if (tool.exit_code === null)
        problems.push(`${tool.id}: executed without a recorded exit code`);
      if (!exists(tool.raw.stdout)) {
        problems.push(`${tool.id}: raw stdout missing (${String(tool.raw.stdout)})`);
      }
    } else {
      if (tool.reason === null || tool.reason.trim() === "") {
        problems.push(`${tool.id}: status ${tool.status} without a reason`);
      }
      if (tool.finding_count !== 0 && tool.status !== "failure") {
        problems.push(`${tool.id}: unexecuted tool reports ${tool.finding_count} findings`);
      }
    }
  }

  // 2. Tool ids are unique.
  const seen = new Set<string>();
  for (const tool of audit.tools) {
    if (seen.has(tool.id)) problems.push(`duplicate tool entry: ${tool.id}`);
    seen.add(tool.id);
  }

  // 3. Every finding points at real evidence and a consistent dedupe key.
  const findingIds = new Set<string>();
  for (const finding of audit.findings) {
    if (findingIds.has(finding.id)) problems.push(`duplicate finding id: ${finding.id}`);
    findingIds.add(finding.id);
    if (!exists(finding.provenance.raw_output)) {
      problems.push(`${finding.id}: raw_output missing (${finding.provenance.raw_output})`);
    }
    if (finding.dedupe_key !== dedupeKey(finding.path, finding.line, finding.category)) {
      problems.push(`${finding.id}: dedupe_key does not match path/line/category`);
    }
    if (
      finding.provenance.json_pointer !== null &&
      !finding.provenance.json_pointer.startsWith("/")
    ) {
      problems.push(`${finding.id}: json_pointer must be a JSON pointer`);
    }
  }

  // 4. The counts the collector wrote describe the findings it wrote. Checked only
  // before adjudication: a merged audit legitimately has fewer unreviewed rows.
  const verdictsPath = join(dir, "verification", "verifier-verdicts.json");
  const hasVerdicts = existsSync(verdictsPath);
  if (!hasVerdicts && audit.verification.counts.unreviewed !== audit.findings.length) {
    problems.push(
      `verification.counts.unreviewed ${audit.verification.counts.unreviewed} != ${audit.findings.length} findings in the audit`,
    );
  }

  // 5. The sample is a subset of the findings and its strata add up.
  const samplePath = join(dir, "sample.json");
  if (!existsSync(samplePath)) {
    problems.push("sample.json missing — the verification sample must exist before adjudication");
  } else {
    const sample = JSON.parse(readFileSync(samplePath, "utf8")) as AuditSample;
    for (const id of sample.finding_ids) {
      if (!findingIds.has(id)) problems.push(`sample references unknown finding: ${id}`);
    }
    const stratumTotal = sample.strata.reduce((sum, s) => sum + s.sampled, 0);
    if (stratumTotal !== sample.finding_ids.length) {
      problems.push(
        `sample strata total ${stratumTotal} != ${sample.finding_ids.length} sampled ids`,
      );
    }
  }

  // 6. Writes were declared.
  if (audit.undeclared_deltas.length > 0) {
    problems.push(`undeclared tree changes: ${audit.undeclared_deltas.join(", ")}`);
  }
  if (!audit.run.tree_unchanged) {
    problems.push("tree_unchanged is false — a pre-existing file changed during the audit");
  }

  // 7. Verdicts, when the adjudicator left any: merge them and recompute counts.
  let merged = audit;
  let mergedCount = 0;
  if (hasVerdicts) {
    const rows = z
      .array(z.unknown())
      .min(1)
      .parse(JSON.parse(readFileSync(verdictsPath, "utf8")));
    const verdicts: Verdict[] = rows.map(normalizeVerdict);
    for (const verdict of verdicts) {
      if (!exists(verdict.evidence_ref)) {
        problems.push(`verdict evidence missing: ${verdict.evidence_ref}`);
      }
    }
    const result = mergeVerdicts(audit.findings, verdicts, new Date().toISOString());
    problems.push(...result.problems);
    mergedCount = result.merged;
    merged = {
      ...audit,
      findings: result.findings,
      verification: { ...audit.verification, counts: result.counts, by_family: result.byFamily },
    };
    writeFileSync(join(dir, "audit.json"), `${JSON.stringify(merged, null, 2)}\n`);
  }

  return { problems, merged, mergedCount };
}
