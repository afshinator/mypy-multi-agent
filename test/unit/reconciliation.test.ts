/**
 * Unit tests for the reconciliation module.
 */
import { describe, expect, it } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { Reconciliation } from "../../src/supervisor/reconciliation";

const report = (agentId: string, text: string): A2AEnvelope => ({
  id: `r-${agentId}`,
  timestamp: 0,
  sender: agentId,
  recipient: "supervisor",
  type: "FINAL_REPORT",
  payload: { agentId, report: text },
});

describe("Reconciliation", () => {
  it("captures a final report", () => {
    const r = new Reconciliation();
    expect(r.captureFinalReport(report("a", "done"))).toBe(true);
    expect(r.hasReport("a")).toBe(true);
    expect(r.reportCount()).toBe(1);
  });

  it("keeps the latest report per agent (overwrites earlier)", () => {
    const r = new Reconciliation();
    expect(r.captureFinalReport(report("a", "first"))).toBe(true);
    expect(r.captureFinalReport(report("a", "second"))).toBe(true);
    expect(r.reportCount()).toBe(1);
    expect((r.reports().get("a")!.payload as { report: string }).report).toBe("second");
  });
});
