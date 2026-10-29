/**
 * Unit tests for the finalization module.
 */
import { describe, expect, it } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { EXIT } from "../../src/runtime/exit";
import {
  citedPaths,
  criteriaMismatches,
  criteriaSatisfied,
  finalize,
  finalizeReplyBase,
  gateResultFromTerms,
  staleCitations,
  toolReadTimes,
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

  it("ignores run-written artifacts, whose cited lines cannot move", () => {
    expect(citedPaths("conversation.jsonl:58 and tool-calls.jsonl:9")).toEqual([]);
    // post-mortem-01: a bare `spans.jsonl` in a passing verdict resolved against
    // the run's own run-details/ and was rejected as stale. Same for the other
    // artifacts the runtime writes at finalize.
    expect(citedPaths("spans.jsonl:1-132 and final.md and findings.md and scorecard.json")).toEqual(
      [],
    );
  });

  it("still checks the supervisor's own artifacts, which it must freeze before attesting", () => {
    expect(citedPaths("findings-summary.md:12 and plan.md:3 and docs/a.md:1")).toEqual([
      "findings-summary.md",
      "plan.md",
      "docs/a.md",
    ]);
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

  it("reports a file rewritten after the attester read it, before the attestation", () => {
    // The mtime is older than the attestation, so the coarse rule misses it: the
    // rewrite landed between the reviewer's read and the attestation (issue #8).
    const readAt = at - 400;
    const stale = staleCitations(
      v("docs/a.md:12"),
      at,
      () => at - 100,
      (p) => (p === "docs/a.md" ? readAt : undefined),
    );
    expect(stale).toEqual([
      { path: "docs/a.md", attestedAtMs: at, modifiedAtMs: at - 100, readAtMs: readAt },
    ]);
  });

  it("accepts a file written before the attester read it", () => {
    expect(
      staleCitations(
        v("docs/a.md:12"),
        at,
        () => at - 300,
        () => at - 200,
      ),
    ).toEqual([]);
  });

  it("judges only by the attestation when the attester never read the file", () => {
    expect(
      staleCitations(
        v("docs/a.md:12"),
        at,
        () => at - 100,
        () => undefined,
      ),
    ).toEqual([]);
    expect(
      staleCitations(
        v("docs/a.md:12"),
        at,
        () => at + 100,
        () => undefined,
      ),
    ).toHaveLength(1);
  });
});

describe("toolReadTimes (issue #8)", () => {
  const resolvePath = (p: string) => (p.startsWith("/") ? p : `/ws/${p}`);

  it("keeps the last read time per path, for the attester's read calls only", () => {
    const times = toolReadTimes(
      [
        { agentId: "reviewer", toolName: "read", timestamp: 10, args: { path: "src/a.ts" } },
        { agentId: "reviewer", toolName: "read", timestamp: 30, args: { path: "src/a.ts" } },
        { agentId: "reviewer", toolName: "read", timestamp: 20, args: { path: "/abs/b.ts" } },
        { agentId: "reviewer", toolName: "bash", timestamp: 40, args: { command: "cat a" } },
        { agentId: "implementer", toolName: "read", timestamp: 50, args: { path: "src/a.ts" } },
        { agentId: "reviewer", toolName: "read", timestamp: 60, args: {} },
        { agentId: "reviewer", toolName: "read", timestamp: 70 },
      ],
      "reviewer",
      resolvePath,
    );
    expect(times.get("/ws/src/a.ts")).toBe(30);
    expect(times.get("/abs/b.ts")).toBe(20);
    expect(times.size).toBe(2);
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

  it("ignores a C1-style criterion label on either side (issue #22)", () => {
    const dod = ["Snapshot written at boundaries.", "Resume is explicit only."];
    const labelled = [
      { criterion: "C1 Snapshot written at boundaries.", result: "pass" as const, evidence: "x" },
      { criterion: "C2. Resume is explicit only.", result: "pass" as const, evidence: "x" },
    ] as const;
    expect(criteriaSatisfied(labelled, dod)).toBe(true);
    // A criterion that itself starts with dashes keeps them.
    expect(
      criteriaSatisfied(
        [{ criterion: "C1 --resume keeps its dashes.", result: "pass", evidence: "x" }],
        ["--resume keeps its dashes."],
      ),
    ).toBe(true);
    // Same labels, wrong order: still not done.
    expect(criteriaSatisfied([labelled[1], labelled[0]], dod)).toBe(false);
    // A label does not excuse a rephrased criterion.
    expect(
      criteriaSatisfied(
        [{ criterion: "C1 Snapshot persisted.", result: "pass", evidence: "x" }, labelled[1]],
        dod,
      ),
    ).toBe(false);
    // A labelled fail is still a fail.
    expect(
      criteriaSatisfied(
        [
          { criterion: "C1 Snapshot written at boundaries.", result: "fail", evidence: "x" },
          labelled[1],
        ],
        dod,
      ),
    ).toBe(false);
    // A label on both sides is stripped from both, so nothing changes.
    expect(
      criteriaSatisfied(
        [{ criterion: "A5 threshold exceeded.", result: "pass", evidence: "x" }],
        ["A5 threshold exceeded."],
      ),
    ).toBe(true);
  });

  it("ignores a CRITERION N — long-form criterion label", () => {
    const dod = [
      "`run-details/x.md` exists and contains the output of `fallow dead-code`, `fallow health`, and `biome check .` plus a findings summary.",
    ];
    const labelled = [
      {
        criterion:
          "CRITERION 1 — `run-details/x.md` exists and contains the output of `fallow dead-code`, `fallow health`, and `biome check .` plus a findings summary.",
        result: "pass" as const,
        evidence: "x",
      },
    ] as const;
    expect(criteriaSatisfied(labelled, dod)).toBe(true);
    // Case-insensitive word, em-dash separator.
    expect(
      criteriaSatisfied(
        [{ criterion: "criterion 2 — a.md", result: "pass", evidence: "x" }],
        ["a.md"],
      ),
    ).toBe(true);
    // A long label does not excuse a rephrased criterion.
    expect(
      criteriaSatisfied(
        [{ criterion: "CRITERION 1 — rephrased", result: "pass", evidence: "x" }],
        ["original"],
      ),
    ).toBe(false);
  });

  it("ignores markdown inline-code backticks dropped in transit (issue #118)", () => {
    // The two real DoD entries that failed run architecture-zones-15: the bus
    // block dropped the first inline-code span's backticks on each.
    const dod = [
      "`docs/antislop/architecture-zones.md` states, per zone, the directory patterns it covers and the evidence that the zone exists, and per allowed edge, the invariant it encodes and whether that invariant is true today.",
      "`.fallowrc.json` carries a `boundaries` block whose every declared zone matches at least one file, proven by the recorded fallow run emitting no `boundary zone ... matched 0 files` warning, not by inspection.",
    ];
    const transported = [
      {
        criterion:
          "docs/antislop/architecture-zones.md states, per zone, the directory patterns it covers and the evidence that the zone exists, and per allowed edge, the invariant it encodes and whether that invariant is true today.",
        result: "pass" as const,
        evidence: "x",
      },
      {
        criterion:
          ".fallowrc.json carries a `boundaries` block whose every declared zone matches at least one file, proven by the recorded fallow run emitting no `boundary zone ... matched 0 files` warning, not by inspection.",
        result: "pass" as const,
        evidence: "x",
      },
    ] as const;
    expect(criteriaSatisfied(transported, dod)).toBe(true);
  });

  it("folds backticks symmetrically — a backticked verdict matches a bare DoD (issue #118)", () => {
    const pass = (c: string) => ({ criterion: c, result: "pass" as const, evidence: "x" });
    // Reverse of the run-15 direction. The fold must not be one-sided: if only the
    // verdict (or only the DoD) were stripped, a verdict that keeps its backticks
    // would fail against a bare DoD. Both sides call the same normalizeCriterion.
    expect(criteriaSatisfied([pass("`docs/x.md` exists.")], ["docs/x.md exists."])).toBe(true);
  });

  it("folds cosmetic rendering differences but keeps words and order exact (issue #118)", () => {
    const pass = (c: string) => ({ criterion: c, result: "pass" as const, evidence: "x" });
    // Curly quotes, en/em dash, whitespace and backticks fold; words must not.
    expect(
      criteriaSatisfied(
        [pass("fold “smart” quotes, an — em dash, and   whitespace")],
        ['fold "smart" quotes, an - em dash, and whitespace'],
      ),
    ).toBe(true);
    // Two semantically different criteria still compare unequal after folding.
    expect(
      criteriaSatisfied([pass("every function over 200 lines")], ["every function over 300 lines"]),
    ).toBe(false);
    expect(criteriaSatisfied([pass("a then b")], ["b then a"])).toBe(false);
  });
});

describe("gate outcome and reply (issue #119)", () => {
  it("reports success and exit 0 when no term fails", () => {
    const r = gateResultFromTerms(true, true, true, true, undefined, true);
    expect(r.success).toBe(true);
    expect(r.exitCode).toBe(EXIT.SUCCESS);
    expect(r.failingTerms).toEqual([]);
    expect(finalizeReplyBase(r)).toBe("finalized: success (exit 0)");
  });

  it("names validation with its command, and maps to failure and exit 1", () => {
    const r = gateResultFromTerms(true, true, true, false, "bun run lint", true);
    expect(r.success).toBe(false);
    expect(r.exitCode).toBe(EXIT.FAILURE);
    expect(r.failingTerms).toEqual([{ name: "validation", detail: "bun run lint" }]);
    expect(finalizeReplyBase(r)).toBe(
      "finalized: failure (exit 1) — gate: validation (bun run lint)",
    );
  });

  it("names every failing term in evaluation order; the reply uses the first", () => {
    const r = gateResultFromTerms(false, false, false, false, "bun run lint", false);
    expect(r.failingTerms.map((t) => t.name)).toEqual([
      "dod",
      "criteria",
      "stale-attestation",
      "validation",
      "run-contract",
    ]);
    expect(finalizeReplyBase(r)).toBe("finalized: failure (exit 1) — gate: dod");
  });

  it("returns per-index criteria mismatches, and none when all pass", () => {
    expect(criteriaMismatches(undefined, ["a"])).toEqual([
      { index: -1, expected: "n/a", got: "n/a", result: "fail" },
    ]);
    const pass = [{ criterion: "a", result: "pass" as const, evidence: "x" }];
    expect(criteriaMismatches(pass, ["a"])).toEqual([]);
    expect(
      criteriaMismatches([{ criterion: "z", result: "pass" as const, evidence: "x" }], ["a"]),
    ).toEqual([{ index: 0, expected: "a", got: "z", result: "pass" }]);
  });
});
