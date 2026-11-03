/**
 * The audit gate's CLI half (#169): read, call the checks, print, exit.
 * Returns the exit code instead of exiting, so a test can assert it:
 * 0 valid, 1 contract violation, 2 schema/parse error.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { verifyAudit } from "./checks";
import { type Audit, AuditSchema } from "./schema";

export interface VerifyIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export function runVerify(argv: readonly string[], io: VerifyIo): number {
  const at = argv.indexOf("--out");
  const outDir = at >= 0 ? argv[at + 1] : undefined;
  if (outDir === undefined) {
    io.err("verify: --out <audit-out> is required");
    return 2;
  }
  const dir = resolve(outDir);
  const auditPath = join(dir, "audit.json");
  if (!existsSync(auditPath)) {
    io.err(`verify: no audit.json at ${auditPath}`);
    return 2;
  }

  let audit: Audit;
  try {
    audit = AuditSchema.parse(JSON.parse(readFileSync(auditPath, "utf8")));
  } catch (error) {
    io.err(`verify: schema error — ${(error as Error).message}`);
    return 2;
  }

  let outcome: ReturnType<typeof verifyAudit>;
  try {
    outcome = verifyAudit(audit, { dir });
  } catch (error) {
    io.err(`verify: verdict file invalid — ${(error as Error).message}`);
    return 2;
  }

  if (outcome.problems.length > 0) {
    io.err(`verify: ${outcome.problems.length} problem(s)`);
    for (const problem of outcome.problems) io.err(`  - ${problem}`);
    return 1;
  }

  const { merged, mergedCount } = outcome;
  const sampled = merged.verification.sampling.strata.reduce((s, x) => s + x.sampled, 0);
  io.out(
    `verify: ok — ${merged.findings.length} findings, sample ${sampled}, verdicts merged ${mergedCount}`,
  );
  const c = merged.verification.counts;
  io.out(
    `verify: validity present=${c.present} absent=${c.absent} duplicate=${c.duplicate} undecidable=${c.undecidable} unreviewed=${c.unreviewed}`,
  );
  for (const row of merged.verification.by_family) {
    const dims = `v=${row.validity.present}/${row.sampled} a=${row.actionability.material} c=${row.consequence.high}`;
    io.out(
      `verify: family ${row.tool}/${row.rule_id ?? "-"} ${dims}${row.anecdote ? " (anecdote)" : ""}`,
    );
  }
  io.out(`verify: tools ${merged.tools.map((t) => `${t.id}=${t.status}`).join(", ")}`);
  return 0;
}
