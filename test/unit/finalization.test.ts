/**
 * Unit tests for the finalization module.
 */
import { describe, expect, it } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { EXIT } from "../../src/runtime/exit";
import {
  citedPaths,
  criteriaSatisfied,
  finalize,
  staleCitations,
} from "../../src/supervisor/finalization";
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

describe("staleCitations (O2)", () => {
  const v = (evidence: string) => [{ criterion: "c", result: "pass" as const, evidence }];
  const at = 1_000_000;

  it("finds file references in evidence, with and without a line range", () => {
    expect(citedPaths("docs/a.md:12-34 and src/b.ts:5 and plain text")).toEqual([
      "docs/a.md",
      "src/b.ts",
    ]);
    // A version string is not a path, and duplicates collapse.
    expect(citedPaths("v1.1.0 cited twice: docs/a.md:1 docs/a.md:2")).toEqual(["docs/a.md"]);
  });

  it("ignores append-only logs, whose cited lines cannot move", () => {
    expect(citedPaths("conversation.jsonl:58 and tool-calls.jsonl:9")).toEqual([]);
  });

  it("reports a cited file modified after the attestation", () => {
    const stale = staleCitations(v("docs/a.md:12"), at, (p) =>
      p === "docs/a.md" ? at + 5 : undefined,
    );
    expect(stale).toEqual([{ path: "docs/a.md", attestedAtMs: at, modifiedAtMs: at + 5 }]);
  });

  it("accepts a file modified at or before the attestation", () => {
    expect(staleCitations(v("docs/a.md:12"), at, () => at)).toEqual([]);
    expect(staleCitations(v("docs/a.md:12"), at, () => at - 1)).toEqual([]);
  });

  it("skips an unresolvable path (a missing locator is the locator audit's job)", () => {
    expect(staleCitations(v("docs/gone.md:1"), at, () => undefined)).toEqual([]);
  });

  it("ignores a failing verdict and an unrecorded capture time", () => {
    expect(
      staleCitations(
        [{ criterion: "c", result: "fail", evidence: "docs/a.md:1" }],
        at,
        () => at + 9,
      ),
    ).toEqual([]);
    expect(staleCitations(v("docs/a.md:1"), 0, () => at + 9)).toEqual([]);
  });

  it("dedupes a file cited by several criteria", () => {
    const stale = staleCitations(
      [
        { criterion: "a", result: "pass", evidence: "docs/a.md:1" },
        { criterion: "b", result: "pass", evidence: "docs/a.md:2" },
      ],
      at,
      () => at + 1,
    );
    expect(stale).toHaveLength(1);
  });
});

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

  it("requires exactly one passing verdict per DoD criterion, named verbatim", () => {
    const pass = { criterion: "a", result: "pass" as const, evidence: "x" };
    const passB = { criterion: "b", result: "pass" as const, evidence: "x" };
    const fail = { criterion: "a", result: "fail" as const, evidence: "x" };
    const other = { criterion: "z", result: "pass" as const, evidence: "x" };
    expect(criteriaSatisfied(undefined, ["a"])).toBe(false);
    expect(criteriaSatisfied([pass], ["a"])).toBe(true);
    expect(criteriaSatisfied([fail], ["a"])).toBe(false);
    expect(criteriaSatisfied([pass], ["a", "b"])).toBe(false);
    expect(criteriaSatisfied([pass, passB], ["a", "b"])).toBe(true);
    // RT-8 D2: a verdict naming a different criterion, or a duplicate, is not done.
    expect(criteriaSatisfied([other], ["a"])).toBe(false);
    expect(criteriaSatisfied([pass, pass], ["a", "b"])).toBe(false);
  });
});
