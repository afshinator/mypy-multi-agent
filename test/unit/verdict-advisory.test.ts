import { describe, expect, it } from "vitest";
import { judgeVerdicts } from "../../src/jev/verdict-advisory";

const verdict = (criterion: string, evidence = "e") => ({
  criterion,
  evidence,
  result: "pass" as const,
});

describe("judgeVerdicts", () => {
  it("flags a verdict whose evidence scores below the threshold", async () => {
    const estimate = async ({ criterion }: { criterion: string }) =>
      criterion === "weak" ? 0.2 : 0.9;
    const a = await judgeVerdicts([verdict("strong"), verdict("weak")], "m", 0.5, estimate);
    expect(a.perCriterion.map((c) => c.flagged)).toEqual([false, true]);
    expect(a.flagged).toBe(1);
    expect(a.model).toBe("m");
  });

  it("treats a failed classifier call as flagged (unknown, not a pass)", async () => {
    const estimate = async () => {
      throw new Error("402 insufficient funds");
    };
    const a = await judgeVerdicts([verdict("a")], "m", 0.5, estimate);
    expect(a.perCriterion[0]!.flagged).toBe(true);
    expect(a.perCriterion[0]!.establishes).toBeNull();
  });
});
