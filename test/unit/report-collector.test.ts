/**
 * Unit tests for the report collector: the supervisor gets a path plus a bounded
 * head, and the full report survives on disk for `read` and for findings.md.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { Reconciliation } from "../../src/supervisor/reconciliation";
import { collectReports } from "../../src/supervisor/report-collector";

const report = (agentId: string, text: string): A2AEnvelope => ({
  id: `r-${agentId}`,
  timestamp: 0,
  sender: agentId,
  recipient: "supervisor",
  type: "FINAL_REPORT",
  payload: { agentId, report: text },
});

describe("collectReports", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns each report's path and head, not the whole report", async () => {
    const long = `START ${"x".repeat(4000)} END`;
    const r = new Reconciliation();
    r.captureFinalReport(report("a", long));
    r.captureFinalReport(report("b", "report from b"));
    dir = await mkdtemp(join(tmpdir(), "reports-"));

    const out = await collectReports(r, dir);

    expect(out).toContain("## a");
    expect(out).toContain(join(dir, "a.md"));
    expect(out).toContain("1 lines");
    expect(out).toContain("START");
    expect(out).not.toContain("END"); // the tail is not forwarded
    expect(out).toContain("truncated");
    expect(out).toContain("## b");
    expect(out).toContain("report from b");

    expect(await readFile(join(dir, "a.md"), "utf8")).toBe(`${long}\n`);
    expect(await readFile(join(dir, "b.md"), "utf8")).toBe("report from b\n");
  });

  it("keeps the forwarded head well under the full report's size", async () => {
    const r = new Reconciliation();
    r.captureFinalReport(report("a", "y".repeat(20000)));
    dir = await mkdtemp(join(tmpdir(), "reports-"));

    const out = await collectReports(r, dir);

    expect(out.length).toBeLessThan(2000);
  });

  it("keeps an agent id from climbing out of the reports directory", async () => {
    const r = new Reconciliation();
    r.captureFinalReport(report("../../escape", "report"));
    dir = await mkdtemp(join(tmpdir(), "reports-"));

    await collectReports(r, dir);

    expect(existsSync(join(dir, "..", "..", "escape.md"))).toBe(false);
    expect(await readFile(join(dir, "______escape.md"), "utf8")).toBe("report\n");
  });

  it("returns empty string when no reports", async () => {
    dir = await mkdtemp(join(tmpdir(), "reports-"));
    expect(await collectReports(new Reconciliation(), dir)).toBe("");
  });
});
