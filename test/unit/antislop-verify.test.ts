/**
 * The audit gate's contract checks, callable as a function over data (#169).
 * Each case mutates one thing in the fixture so it fails for that reason alone.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isExecuted, verifyAudit } from "../../scripts/antislop/checks";
import { runVerify } from "../../scripts/antislop/run-verify";
import { type Audit, AuditSchema } from "../../scripts/antislop/schema";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(repoRoot, "test/fixtures/antislop/audit");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture with one mutation, so the evidence files are real. */
function auditDir(mutate?: (audit: Audit) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "antislop-"));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  if (mutate !== undefined) {
    const path = join(dir, "audit.json");
    const audit = AuditSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    mutate(audit);
    writeFileSync(path, `${JSON.stringify(audit, null, 2)}\n`);
  }
  return dir;
}

const silent = { out: () => {}, err: () => {} };

describe("verifyAudit", () => {
  it("accepts the fixture", () => {
    const dir = auditDir();
    const audit = AuditSchema.parse(JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")));
    expect(verifyAudit(audit, { dir })).toEqual({ problems: [], merged: audit, mergedCount: 0 });
  });

  it("fails an executed tool with no recorded exit code", () => {
    const dir = auditDir((audit) => {
      audit.tools[0]!.exit_code = null;
    });
    const audit = AuditSchema.parse(JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")));
    expect(verifyAudit(audit, { dir }).problems).toContain(
      "knip: executed without a recorded exit code",
    );
  });

  it("fails a tool that reports findings without having executed", () => {
    const dir = auditDir((audit) => {
      audit.tools[0]!.status = "blocked";
      audit.tools[0]!.exit_code = null;
      audit.tools[0]!.reason = "no config";
      audit.tools[0]!.finding_count = 3;
    });
    const audit = AuditSchema.parse(JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")));
    expect(verifyAudit(audit, { dir }).problems).toContain(
      "knip: unexecuted tool reports 3 findings",
    );
  });

  it("fails counts that disagree with the findings they describe", () => {
    const dir = auditDir((audit) => {
      audit.verification.counts.unreviewed = 5;
    });
    const audit = AuditSchema.parse(JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")));
    expect(verifyAudit(audit, { dir }).problems).toContain(
      "verification.counts.unreviewed 5 != 1 findings in the audit",
    );
  });

  it("fails a sample that names a finding the audit does not have", () => {
    const dir = auditDir();
    writeFileSync(
      join(dir, "sample.json"),
      JSON.stringify({ finding_ids: ["f1", "nope"], strata: [{ key: "knip", sampled: 2 }] }),
    );
    const audit = AuditSchema.parse(JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")));
    expect(verifyAudit(audit, { dir }).problems).toContain(
      "sample references unknown finding: nope",
    );
  });

  it("merges verdicts when the adjudicator left them", () => {
    const dir = auditDir();
    cpSync(
      join(repoRoot, "test/fixtures/antislop/verdicts.json"),
      join(dir, "verification/verifier-verdicts.json"),
      { recursive: true },
    );
    const audit = AuditSchema.parse(JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")));
    const result = verifyAudit(audit, { dir });
    expect(result.problems).toEqual([]);
    expect(result.mergedCount).toBe(1);
    expect(result.merged.verification.counts.absent).toBe(1);
  });

  it("fails a verdict whose evidence is not on disk", () => {
    const dir = auditDir();
    mkdirSync(join(dir, "verification"), { recursive: true });
    writeFileSync(
      join(dir, "verification", "verifier-verdicts.json"),
      JSON.stringify([
        {
          id: "f1",
          by: "reviewer",
          method: "read",
          evidence_ref: "raw/missing.txt",
          validity: "absent",
        },
      ]),
    );
    const audit = AuditSchema.parse(JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")));
    const result = verifyAudit(audit, { dir });
    expect(result.problems).toContain("verdict evidence missing: raw/missing.txt");
    expect(result.mergedCount).toBe(1);
  });
});

describe("runVerify — the exit path", () => {
  it("exits 0 for the valid fixture", () => {
    expect(runVerify(["--out", auditDir()], silent)).toBe(0);
  });

  it("exits 1 for a contract violation", () => {
    const dir = auditDir((audit) => {
      audit.tools[0]!.exit_code = null;
    });
    expect(runVerify(["--out", dir], silent)).toBe(1);
  });

  it("exits 2 for a stale schema version", () => {
    const dir = auditDir();
    const path = join(dir, "audit.json");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"schema_version": "0.5"', '"schema_version": "0.4"'),
    );
    expect(runVerify(["--out", dir], silent)).toBe(2);
  });

  it("exits 2 when there is no audit.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "antislop-empty-"));
    dirs.push(dir);
    expect(runVerify(["--out", dir], silent)).toBe(2);
  });

  it("exits 2 without --out", () => {
    expect(runVerify([], silent)).toBe(2);
  });
});

describe("the executed predicate is stated once", () => {
  it("is exported from checks and imported by both callers", () => {
    expect(isExecuted({ status: "clean", exit_code: 0 } as never)).toBe(true);
    expect(isExecuted({ status: "blocked", exit_code: null } as never)).toBe(false);
    for (const file of ["collect.ts", "run-verify.ts"]) {
      const source = readFileSync(join(repoRoot, "scripts/antislop", file), "utf8");
      expect(source).not.toContain('status === "clean" ||');
    }
  });
});
