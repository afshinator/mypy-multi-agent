/**
 * Unit tests for the report collector module.
 */
import { describe, expect, it } from "vitest";
import { collectReports } from "../../src/supervisor/report-collector";
import { Reconciliation } from "../../src/supervisor/reconciliation";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

const report = (agentId: string, text: string): A2AEnvelope => ({
  id: `r-${agentId}`,
  timestamp: 0,
  sender: agentId,
  recipient: "supervisor",
  type: "FINAL_REPORT",
  payload: { agentId, report: text },
});

describe("collectReports", () => {
  it("formats captured reports", () => {
    const r = new Reconciliation();
    r.captureFinalReport(report("a", "report from a"));
    r.captureFinalReport(report("b", "report from b"));
    const out = collectReports(r);
    expect(out).toContain("## a");
    expect(out).toContain("report from a");
    expect(out).toContain("## b");
    expect(out).toContain("report from b");
  });

  it("returns empty string when no reports", () => {
    expect(collectReports(new Reconciliation())).toBe("");
  });
});
