import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../lib/frontmatter";
import { buildRunData, parseCriteria } from "../lib/run-data";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const fullFinal = fixture("final-full.md");
const scorecard = fixture("scorecard-fallback.json");
const runState = fixture("run-state-recent.json");

describe("parseFrontmatter", () => {
  it("parses final.md frontmatter summary fields", () => {
    const fm = parseFrontmatter(fullFinal);
    expect(fm.status).toBe("success");
    expect(fm.exit_code).toBe(0);
    expect(fm.total_cost_usd).toBe(0.46);
    expect(fm.total_tokens).toBe(3615375);
    expect(fm.supervisor_cost_usd).toBe(0.23);
    expect(fm.supervisor_tokens).toBe(1236868);
    expect(Array.isArray(fm.agents)).toBe(true);
    expect(fm.agents).toHaveLength(3);
  });
});

describe("parseCriteria", () => {
  it("parses the ## Criteria section into pass/fail verdicts with evidence", () => {
    const criteria = parseCriteria(fullFinal);
    expect(criteria).toHaveLength(5);
    expect(criteria.every((c) => c.pass)).toBe(true);
    const first = criteria[0];
    expect(first?.criterion).toContain("top-level `shared/` module");
    expect(first?.evidence).toContain("`shared/parse-jsonl.ts`");
  });

  it("marks unchecked criteria as failed", () => {
    const criteria = parseCriteria(
      "## Criteria\n\n- [x] done — evidence A\n- [ ] missing — evidence B\n",
    );
    expect(criteria[0]?.pass).toBe(true);
    expect(criteria[1]?.pass).toBe(false);
    expect(criteria[1]?.criterion).toBe("missing");
    expect(criteria[1]?.evidence).toBe("evidence B");
  });
});

describe("buildRunData", () => {
  it("builds the aggregate from final.md frontmatter and criteria", () => {
    const data = buildRunData({ finalMd: fullFinal });
    expect(data.summary.outcome).toBe("success");
    expect(data.summary.exitCode).toBe(0);
    expect(data.summary.totalCostUsd).toBe(0.46);
    expect(data.summary.totalTokens).toBe(3615375);
    expect(data.summary.supervisorCostUsd).toBe(0.23);
    expect(data.summary.supervisorTokens).toBe(1236868);
    expect(data.summary.agents).toEqual([
      { name: "implementer", costUsd: 0.2, tokens: 1771470 },
      { name: "test_verifier", costUsd: 0.02, tokens: 295015 },
      { name: "reviewer", costUsd: 0.01, tokens: 312022 },
    ]);
    expect(data.criteria).toHaveLength(5);
  });

  it("falls back to scorecard cost/tokens when final.md is absent", () => {
    const data = buildRunData({ scorecardJson: scorecard, runStateJson: runState });
    expect(data.summary.outcome).toBe("failure");
    expect(data.summary.exitCode).toBe(1);
    expect(data.summary.totalCostUsd).toBe(0.99);
    expect(data.summary.totalTokens).toBe(999);
    expect(data.summary.supervisorCostUsd).toBe(0.5);
    expect(data.summary.supervisorTokens).toBe(400);
    expect(data.summary.agents).toEqual([{ name: "implementer", costUsd: 0.49, tokens: 599 }]);
    expect(data.criteria).toEqual([]);
  });

  it("falls back to run-state totals and agents when final.md and scorecard are absent", () => {
    const data = buildRunData({ runStateJson: runState });
    expect(data.summary.outcome).toBe("unknown");
    expect(data.summary.exitCode).toBeUndefined();
    expect(data.summary.totalCostUsd).toBe(0.3);
    expect(data.summary.totalTokens).toBe(2378507);
    expect(data.summary.agents).toEqual([{ name: "implementer", costUsd: 0.2, tokens: 1771470 }]);
  });

  it("records source availability for absent-artifact decisions", () => {
    expect(buildRunData({ finalMd: fullFinal }).hasFinalMd).toBe(true);
    expect(buildRunData({ finalMd: fullFinal }).hasSummary).toBe(true);
    expect(buildRunData({ scorecardJson: scorecard, runStateJson: runState }).hasFinalMd).toBe(
      false,
    );
    expect(buildRunData({ scorecardJson: scorecard, runStateJson: runState }).hasSummary).toBe(
      true,
    );
    expect(buildRunData({}).hasFinalMd).toBe(false);
    expect(buildRunData({}).hasSummary).toBe(false);
  });
});
