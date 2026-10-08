/**
 * Unit tests for the finalization module.
 */
import { describe, expect, it } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { EXIT } from "../../src/runtime/exit";
import { criteriaSatisfied, finalize } from "../../src/supervisor/finalization";
import { Reconciliation } from "../../src/supervisor/reconciliation";

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

  it("carries the supervisor's decision into the finalization", () => {
    const f = finalize(recWith("a"), true, "S1: dev_a vs dev_b — kept dev_a.");
    expect(f.decision).toBe("S1: dev_a vs dev_b — kept dev_a.");
  });

  it("requires exactly one passing verdict per DoD criterion", () => {
    const pass = { criterion: "a", result: "pass" as const, evidence: "x" };
    const fail = { criterion: "a", result: "fail" as const, evidence: "x" };
    expect(criteriaSatisfied(undefined, ["a"])).toBe(false);
    expect(criteriaSatisfied([pass], ["a"])).toBe(true);
    expect(criteriaSatisfied([fail], ["a"])).toBe(false);
    expect(criteriaSatisfied([pass], ["a", "b"])).toBe(false);
    expect(criteriaSatisfied([pass, pass], ["a", "b"])).toBe(true);
  });
});
