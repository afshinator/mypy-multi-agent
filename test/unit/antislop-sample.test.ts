/**
 * Sampling contract: strata are keyed by (tool, rule family) and small unique classes
 * are floored before large noisy ones can consume the budget. This test exists because
 * the previous category-keyed sampler silently skipped knip's `exports`/`types` families
 * and produced a wrong keep/drop verdict (issue #108).
 */
import { describe, expect, it } from "vitest";
import { pickSample, ruleFamily } from "../../scripts/antislop/sample";
import { dedupeKey, type Finding } from "../../scripts/antislop/schema";

const finding = (tool: string, rule: string, i: number): Finding => {
  const path = `src/f${i}.ts`;
  return {
    id: `${tool}:${rule}:${path}:${i}:${i}`,
    tools: [tool],
    primary_tool: tool,
    rule_id: rule,
    category: "unused_file_export_dep",
    severity: "warning",
    path,
    line: i,
    message: "m",
    dedupe_key: dedupeKey(path, i, "unused_file_export_dep"),
    verification: {
      status: "unreviewed",
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
  };
};

describe("ruleFamily", () => {
  it("keeps knip's issue keys whole, since each is a distinct class", () => {
    expect(ruleFamily("files")).toBe("files");
    expect(ruleFamily("exports")).toBe("exports");
    expect(ruleFamily("types")).toBe("types");
    expect(ruleFamily("binaries")).toBe("binaries");
  });

  it("collapses rule ids to the family a human would name", () => {
    expect(ruleFamily("lint/style/noNonNullAssertion")).toBe("lint/style");
    expect(ruleFamily("lint/suspicious/noExplicitAny")).toBe("lint/suspicious");
    expect(ruleFamily("unicorn(no-useless-spread)")).toBe("unicorn");
    expect(ruleFamily("ai-slop/double-type-assertion")).toBe("ai-slop");
    expect(ruleFamily("exact")).toBe("exact");
    expect(ruleFamily(null)).toBe("unknown");
  });
});

describe("pickSample", () => {
  it("samples a tiny unique family even beside a huge noisy one", () => {
    const findings = [
      ...Array.from({ length: 300 }, (_, i) => finding("knip", "files", i)),
      ...Array.from({ length: 4 }, (_, i) => finding("knip", "exports", i)),
    ];
    const { strata, ids } = pickSample(findings, 7);
    const byKey = new Map(strata.map((s) => [s.key, s]));
    // The old category-keyed sampler gave this pair a single stratum of 9 samples and
    // drew zero exports verdicts.
    expect(byKey.get("knip/files")?.sampled).toBeGreaterThan(0);
    expect(byKey.get("knip/exports")?.sampled).toBe(4);
    expect(ids.length).toBe(strata.reduce((sum, s) => sum + s.ids.length, 0));
  });

  it("floors every family before topping up, so nothing under 5 is skipped", () => {
    const findings = [
      ...Array.from({ length: 200 }, (_, i) => finding("jscpd", "exact", i)),
      ...Array.from({ length: 2 }, (_, i) => finding("biome", "format", i)),
      ...Array.from({ length: 3 }, (_, i) => finding("oxlint", "eslint", i)),
    ];
    const { strata } = pickSample(findings, 11);
    const byKey = new Map(strata.map((s) => [s.key, s]));
    expect(byKey.get("biome/format")?.sampled).toBe(2);
    expect(byKey.get("oxlint/eslint")?.sampled).toBe(3);
  });

  it("never exceeds the cap and never cuts a family below its floor", () => {
    const findings = Array.from({ length: 40 }, (_, i) => finding("jscpd", "exact", i));
    const { strata, ids } = pickSample(findings, 3, 12);
    expect(ids.length).toBeLessThanOrEqual(12);
    for (const stratum of strata) {
      if (stratum.key === "unallocated") continue;
      expect(stratum.sampled).toBeLessThanOrEqual(stratum.frame);
    }
  });

  it("is reproducible for one seed and different across seeds", () => {
    const findings = Array.from({ length: 60 }, (_, i) =>
      finding("fallow", i % 2 === 0 ? "unused_exports" : "crap", i),
    );
    expect(pickSample(findings, 5).ids).toEqual(pickSample(findings, 5).ids);
    expect(pickSample(findings, 5).ids).not.toEqual(pickSample(findings, 6).ids);
  });

  it("keeps every family visible in the record even when the cap cannot cover them all", () => {
    // 30 families of one finding each against a cap of 10: ten get sampled, and the
    // other twenty must still appear with sampled 0 rather than vanish.
    const findings = Array.from({ length: 30 }, (_, i) =>
      finding(`tool${String(i).padStart(2, "0")}`, "r", 0),
    );
    const { strata, ids } = pickSample(findings, 1, 10);
    expect(strata).toHaveLength(30);
    expect(strata.filter((s) => s.sampled > 0)).toHaveLength(10);
    expect(strata.filter((s) => s.sampled === 0)).toHaveLength(20);
    expect(ids).toHaveLength(10);
  });

  it("never leaves the largest family unmeasured", () => {
    const findings = [
      ...Array.from({ length: 376 }, (_, i) => finding("jscpd", "exact", i)),
      ...Array.from({ length: 59 }, (_, i) => finding("knip", "files", i)),
      ...Array.from({ length: 3 }, (_, i) => finding("knip", "exports", i)),
    ];
    const { strata } = pickSample(findings, 2, 80);
    const byKey = new Map(strata.map((s) => [s.key, s]));
    expect(byKey.get("jscpd/exact")?.sampled).toBeGreaterThan(0);
    expect(byKey.get("knip/exports")?.sampled).toBe(3);
  });
});
