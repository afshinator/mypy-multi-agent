#!/usr/bin/env bun
/**
 * Contract check for a collected audit. Fails on missing evidence, not on findings.
 *
 *   bun scripts/antislop/verify.ts --out <audit-out> [--prefix <toolchain-prefix>]
 *
 * Exit: 0 valid, 1 contract violation, 2 schema/parse error.
 *
 * When `<out>/verification/verifier-verdicts.json` exists it is merged into
 * `audit.json` and the verdict counts are recomputed. No confidence interval is
 * produced: the frame is tool output, not a probability sample.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { type Audit, AuditSchema, dedupeKey } from "./schema";

const VerdictSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(["verified", "false_positive", "duplicate", "inconclusive"]),
  by: z.string().min(1),
  method: z.string().min(1),
  evidence_ref: z.string().min(1),
});
const VerdictsSchema = z.array(VerdictSchema).min(1);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const outDir = arg("--out");
if (outDir === undefined) {
  console.error("verify: --out <audit-out> is required");
  process.exit(2);
}
const root = resolve(outDir);
const auditPath = join(root, "audit.json");
if (!existsSync(auditPath)) {
  console.error(`verify: no audit.json at ${auditPath}`);
  process.exit(2);
}

let parsed: Audit;
try {
  parsed = AuditSchema.parse(JSON.parse(readFileSync(auditPath, "utf8")));
} catch (error) {
  console.error(`verify: schema error — ${(error as Error).message}`);
  process.exit(2);
}

const problems: string[] = [];
const exists = (rel: string | null): boolean => rel !== null && existsSync(join(root, rel));

// 1. Every executed tool kept its raw evidence.
for (const tool of parsed.tools) {
  const executed = tool.status === "clean" || tool.status === "success_with_findings";
  if (executed) {
    if (tool.exit_code === null) problems.push(`${tool.id}: executed without a recorded exit code`);
    if (!exists(tool.raw.stdout))
      problems.push(`${tool.id}: raw stdout missing (${String(tool.raw.stdout)})`);
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
for (const tool of parsed.tools) {
  if (seen.has(tool.id)) problems.push(`duplicate tool entry: ${tool.id}`);
  seen.add(tool.id);
}

// 3. Every finding points at real evidence and a consistent dedupe key.
const findingIds = new Set<string>();
for (const finding of parsed.findings) {
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

// 4. The sample is a subset of the findings and its strata add up.
const samplePath = join(root, "sample.json");
if (!existsSync(samplePath)) {
  problems.push("sample.json missing — the verification sample must exist before adjudication");
} else {
  const sample = JSON.parse(readFileSync(samplePath, "utf8")) as {
    finding_ids: string[];
    strata: { sampled: number }[];
  };
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

// 5. Writes were declared.
if (parsed.undeclared_deltas.length > 0) {
  problems.push(`undeclared tree changes: ${parsed.undeclared_deltas.join(", ")}`);
}
if (!parsed.run.tree_unchanged) {
  problems.push("tree_unchanged is false — a pre-existing file changed during the audit");
}

// 6. Optional: merge verifier verdicts and recompute counts.
const verdictsPath = join(root, "verification", "verifier-verdicts.json");
let merged: Audit = parsed;
let mergedCount = 0;
if (existsSync(verdictsPath)) {
  let verdicts: z.infer<typeof VerdictsSchema>;
  try {
    verdicts = VerdictsSchema.parse(JSON.parse(readFileSync(verdictsPath, "utf8")));
  } catch (error) {
    console.error(`verify: verdict file invalid — ${(error as Error).message}`);
    process.exit(2);
  }
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  for (const id of byId.keys()) {
    if (!findingIds.has(id)) problems.push(`verdict for unknown finding: ${id}`);
  }
  const counts = { verified: 0, false_positive: 0, duplicate: 0, inconclusive: 0, unreviewed: 0 };
  const updated = parsed.findings.map((finding) => {
    const verdict = byId.get(finding.id);
    if (verdict === undefined) {
      counts.unreviewed += 1;
      return finding;
    }
    mergedCount += 1;
    counts[verdict.status] += 1;
    return {
      ...finding,
      verification: {
        status: verdict.status,
        by: verdict.by,
        method: verdict.method,
        evidence_ref: verdict.evidence_ref,
        checked_at: new Date().toISOString(),
      },
    };
  });
  for (const verdict of verdicts) {
    if (!exists(verdict.evidence_ref))
      problems.push(`verdict evidence missing: ${verdict.evidence_ref}`);
  }
  merged = { ...parsed, findings: updated, verification: { ...parsed.verification, counts } };
  writeFileSync(auditPath, `${JSON.stringify(merged, null, 2)}\n`);
}

if (problems.length > 0) {
  console.error(`verify: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const summary = merged.tools.map((t) => `${t.id}=${t.status}`).join(", ");
console.log(
  `verify: ok — ${merged.findings.length} findings, sample ${merged.verification.sampling.strata.reduce((s, x) => s + x.sampled, 0)}, verdicts merged ${mergedCount}`,
);
console.log(`verify: tools ${summary}`);
