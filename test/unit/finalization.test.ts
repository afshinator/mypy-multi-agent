import { describe, expect, it } from "vitest";
import { finalize } from "../../src/supervisor/finalization";
import { Reconciliation } from "../../src/supervisor/reconciliation";
import { EXIT } from "../../src/runtime/exit";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

const report = (agentId: string, text: string): A2AEnvelope => ({
  id: `r-${agentId}`,
  timestamp: 0,
  sender: agentId,
  recipient: "supervisor",
  type: "FINAL_REPORT",
  payload: { agentId, report: text },
});

function recWith(...agents: string[]) {
  const r = new Reconciliation();
  for (const a of agents) r.captureFinalReport(report(a, `report from ${a}`));
  return r;
}

describe("finalize", () => {
  it("DoD satisfied → success, exit 0", () => {
    const f = finalize(recWith("a", "b"), true);
    expect(f.outcome).toBe("success");
    expect(f.exitCode).toBe(EXIT.SUCCESS);
    expect(f.reports).toHaveLength(2);
  });

  it("DoD not satisfied → failure, exit 1", () => {
    const f = finalize(recWith("a"), false);
    expect(f.outcome).toBe("failure");
    expect(f.exitCode).toBe(EXIT.FAILURE);
  });

  it("succeeds while a peer is still working (no report required)", () => {
    const f = finalize(recWith("a"), true);
    expect(f.outcome).toBe("success");
    expect(f.reports).toHaveLength(1);
  });
});
