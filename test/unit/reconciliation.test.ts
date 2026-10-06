import { describe, expect, it } from "vitest";
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

describe("Reconciliation", () => {
  it("captures a final report", () => {
    const r = new Reconciliation();
    expect(r.captureFinalReport(report("a", "done"))).toBe(true);
    expect(r.hasReport("a")).toBe(true);
    expect(r.reportCount()).toBe(1);
  });

  it("captures each agent's report exactly once", () => {
    const r = new Reconciliation();
    expect(r.captureFinalReport(report("a", "done"))).toBe(true);
    expect(r.captureFinalReport(report("a", "again"))).toBe(false);
    expect(r.reportCount()).toBe(1);
  });
});
