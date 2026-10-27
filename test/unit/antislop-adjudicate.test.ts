import { describe, expect, it } from "vitest";
import {
  actionabilityShare,
  aggregateFamilies,
  dimensionProblems,
  mergeVerdicts,
  normalizeVerdict,
} from "../../scripts/antislop/adjudicate";
import { dedupeKey, type Finding } from "../../scripts/antislop/schema";

const finding = (tool: string, rule: string, i: number): Finding => ({
  id: `${tool}:${rule}:a.ts:${i}`,
  tools: [tool],
  primary_tool: tool,
  rule_id: rule,
  category: "complexity",
  severity: "warning",
  path: "a.ts",
  line: i,
  message: "m",
  dedupe_key: dedupeKey("a.ts", i, "complexity"),
  verification: {
    validity: "unreviewed",
    actionability: "not_applicable",
    consequence: "not_applicable",
    by: null,
    method: null,
    evidence_ref: null,
    checked_at: null,
  },
  provenance: {
    tool_id: tool,
    tool_version: "1",
    raw_output: "raw/x.json",
    json_pointer: null,
    invocation_index: 0,
  },
});

const verdict = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  by: "v",
  method: "read a.ts",
  evidence_ref: "a.ts:1",
  reason: "read the code",
  validity: "present",
  actionability: "material",
  consequence: "high",
  ...over,
});

describe("adjudication dimensions", () => {
  it("lifts the pilot's legacy status onto validity and marks the other dimensions N/A", () => {
    // A real legacy row carries only `status`: no dimension fields exist to inherit.
    const { validity, actionability, consequence, ...legacy } = verdict("x");
    const v = normalizeVerdict({ ...legacy, status: "false_positive" });
    expect(v.validity).toBe("absent");
    expect(v.actionability).toBe("not_applicable");
    expect(v.consequence).toBe("not_applicable");
  });

  it("refuses a verdict with neither validity nor a known status", () => {
    const raw = { ...verdict("x"), validity: undefined, status: "looks_bad" };
    expect(() => normalizeVerdict(raw)).toThrow(/neither a validity nor a known status/);
  });

  it("requires both dimensions when the condition is present", () => {
    const problems = dimensionProblems(
      normalizeVerdict(verdict("x", { actionability: "not_applicable" })),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/requires an actionability and a consequence/);
  });

  it("forbids actionability when the condition is absent", () => {
    const problems = dimensionProblems(normalizeVerdict(verdict("x", { validity: "absent" })));
    expect(problems[0]).toMatch(/cannot be actionable/);
  });

  it("reports the three dimensions per rule family, not per tool", () => {
    const findings = [
      finding("fallow", "crap", 1),
      finding("fallow", "crap", 2),
      finding("fallow", "unused_exports", 3),
    ];
    const verdicts = [
      normalizeVerdict(
        verdict(findings[0]?.id ?? "", { actionability: "none", consequence: "low" }),
      ),
      normalizeVerdict(
        verdict(findings[1]?.id ?? "", { actionability: "none", consequence: "low" }),
      ),
      normalizeVerdict(verdict(findings[2]?.id ?? "")),
    ];
    const rows = aggregateFamilies(findings, verdicts);
    expect(rows.map((r) => r.rule_id)).toEqual(["crap", "unused_exports"]);
    const crap = rows[0];
    expect(crap?.validity.present).toBe(2);
    expect(crap?.actionability.none).toBe(2);
    expect(crap?.anecdote).toBe(true);
    expect(rows[1]?.actionability.material).toBe(1);
  });

  it("drops the anecdote marker once a family reaches the minimum sample", () => {
    const findings = [1, 2, 3, 4, 5].map((i) => finding("knip", "types", i));
    const verdicts = findings.map((f) => normalizeVerdict(verdict(f.id)));
    const rows = aggregateFamilies(findings, verdicts);
    expect(rows[0]?.sampled).toBe(5);
    expect(rows[0]?.anecdote).toBe(false);
  });

  it("merges counts and flags unknown or duplicated verdicts", () => {
    const findings = [finding("knip", "types", 1), finding("knip", "types", 2)];
    const result = mergeVerdicts(
      findings,
      [
        normalizeVerdict(verdict(findings[0]?.id ?? "")),
        normalizeVerdict(verdict(findings[0]?.id ?? "")),
        normalizeVerdict(verdict("not-a-finding")),
      ],
      "now",
    );
    expect(result.merged).toBe(1);
    expect(result.counts.present).toBe(1);
    expect(result.counts.unreviewed).toBe(1);
    expect(result.problems).toContain(`verdict for unknown finding: not-a-finding`);
    expect(result.problems.some((p) => p.startsWith("duplicate verdict"))).toBe(true);
    expect(result.findings[0]?.verification.actionability).toBe("material");
  });

  it("computes the share of verified findings that are materially actionable", () => {
    const findings = [finding("x", "r", 1), finding("x", "r", 2), finding("x", "r", 3)];
    const verdicts = [
      normalizeVerdict(verdict(findings[0]?.id ?? "")),
      normalizeVerdict(verdict(findings[1]?.id ?? "", { actionability: "none" })),
      normalizeVerdict(verdict(findings[2]?.id ?? "", { validity: "absent" })),
    ];
    const rows = aggregateFamilies(findings, verdicts);
    expect(actionabilityShare(rows)).toBeCloseTo(1 / 2);
    expect(actionabilityShare([])).toBeNull();
  });
});
