/**
 * Normalizer contract: raw reporter output -> findings.
 *
 * Fixtures in `test/fixtures/antislop/` are sliced from real output captured on this
 * repository (see that directory's README), so a change in a tool's JSON shape breaks
 * a test rather than silently producing zero findings.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exitFailure,
  exitProblem,
  extract,
  mergeDuplicates,
  normalizePaths,
  reportedFileCount,
  toFindings,
  toolStatus,
} from "../../scripts/antislop/normalize";
import { dedupeKey, type Finding, mulberry32 } from "../../scripts/antislop/schema";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", "antislop", name), "utf8");

/** A minimal finding, for the path/merge tests that care about the key, not the payload. */
const finding = (tool: string, rule: string, path: string, line: number): Finding => ({
  id: `${tool}:${rule}:${path}:${line}:test`,
  tools: [tool],
  primary_tool: tool,
  rule_id: rule,
  category: "lint_correctness",
  severity: "warning",
  path,
  line,
  message: "m",
  dedupe_key: dedupeKey(path, line, "lint_correctness"),
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
    tool_version: "test",
    raw_output: "raw/test",
    json_pointer: null,
    invocation_index: 0,
  },
});

describe("extract", () => {
  it("maps biome categories to lint_style and lint_correctness", () => {
    const found = extract("biome", fixture("biome-report.json"));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.path).toMatch(/\.ts$/);
    expect(found[0]?.rule_id).toMatch(/^lint\//);
    expect(["lint_style", "lint_correctness"]).toContain(found[0]?.category);
    expect(found[0]?.json_pointer).toBe("/diagnostics/0");
  });

  it("keeps knip issue keys verbatim and categorizes cycles separately", () => {
    const found = extract("knip", fixture("knip.json"));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.json_pointer?.startsWith("/issues/"))).toBe(true);
    for (const finding of found) {
      expect(["unused_file_export_dep", "duplication", "dependency_cycle_boundary"]).toContain(
        finding.category,
      );
    }
  });

  it("treats oxlint's no-unused-vars as inline dead code", () => {
    const found = extract("oxlint", fixture("oxlint.json"));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.rule_id).toMatch(/\(/);
    expect(found[0]?.path.length).toBeGreaterThan(0);
  });

  it("separates aislop's ai-slop engine from its lint and format engines", () => {
    const found = extract("aislop", fixture("aislop.json"));
    expect(new Set(found.map((f) => f.category)).size).toBeGreaterThan(1);
    expect(found.every((f) => f.path.length > 0)).toBe(true);
  });

  it("categorizes aislop's code-quality engine by rule, not by engine name", () => {
    const raw = JSON.stringify({
      diagnostics: [
        { engine: "code-quality", rule: "complexity/function-too-long", filePath: "a.ts", line: 3 },
        { engine: "code-quality", rule: "code-quality/duplicate-block", filePath: "b.ts", line: 9 },
      ],
    });
    const found = extract("aislop", raw);
    expect(found.map((f) => f.category)).toEqual(["complexity", "duplication"]);
    expect(found.some((f) => f.category === "unused_file_export_dep")).toBe(false);
  });

  it("gives repeated identical diagnostics on one line distinct ids", () => {
    const raw = JSON.stringify({
      diagnostics: [
        {
          severity: "warning",
          category: "lint/style",
          ruleId: "noNonNullAssertion",
          message: "x",
          location: { path: "a.ts", start: { line: 7, column: 3 } },
        },
        {
          severity: "warning",
          category: "lint/style",
          ruleId: "noNonNullAssertion",
          message: "x",
          location: { path: "a.ts", start: { line: 7, column: 9 } },
        },
      ],
    });
    const found = extract("biome", raw);
    const ids = toFindings({ id: "biome", version: "2.6.2" }, found, "raw/biome.json", 0).map(
      (f) => f.id,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toBe(`${ids[0] ?? ""}#2`);
  });

  it("reads jscpd's file reporter, not its console output", () => {
    const found = extract("jscpd", fixture("jscpd.json"));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.category).toBe("duplication");
    expect(found[0]?.path).toMatch(/\.(ts|tsx|js|yaml|json|md)$/);
    expect(found[0]?.json_pointer).toBe("/duplicates/0");
  });

  it("splits fallow's three reporters by invocation index", () => {
    const deadCode = extract("fallow", fixture("dead-code.json"), 0);
    const dupes = extract("fallow", fixture("dupes.json"), 1);
    const health = extract("fallow", fixture("health.json"), 2);

    expect(deadCode.length).toBeGreaterThan(0);
    expect(deadCode.every((f) => f.category !== "duplication")).toBe(true);
    expect(dupes.every((f) => f.category === "duplication")).toBe(true);
    expect(health.every((f) => f.category === "complexity")).toBe(true);
  });

  it("anchors a dependency finding to the importing file, not the package name", () => {
    const found = extract("fallow", fixture("dead-code.json"), 0);
    const dep = found.find((f) => f.rule_id === "unlisted_dependencies");
    if (dep === undefined) return; // fixture slice may not include it
    expect(dep.path).not.toMatch(/^@/);
    expect(dep.path).toMatch(/\.[a-z]+$/);
    expect(dep.message).toMatch(/\S/);
  });

  it("parses tsc's text reporter", () => {
    const found = extract("tsc", fixture("tsc.txt"));
    expect(found).toHaveLength(2);
    expect(found[0]?.category).toBe("type_error");
    expect(found[0]?.rule_id).toBe("TS2322");
    expect(found[0]?.line).toBe(12);
    expect(found[0]?.path).toBe("src/example.ts");
  });

  it("reads mypy's line-delimited JSON, not a single document", () => {
    const raw = fixture("mypy.jsonl");
    // The whole stream is not one JSON document — that is the contract this guards.
    expect(() => JSON.parse(raw)).toThrow();
    const found = extract("mypy", raw);
    expect(found).toHaveLength(2);
    expect(found[0]?.category).toBe("type_error");
    expect(found[0]?.rule_id).toBe("arg-type");
    expect(found[0]?.path).toBe("fx/mypy_src.py");
    expect(found[0]?.line).toBe(5);
    expect(found[1]?.rule_id).toBe("return-value");
    expect(found[0]?.json_pointer).toBe("/jsonl/0");
  });

  it("ignores non-JSON lines in mypy output instead of failing the parse", () => {
    const found = extract("mypy", "Success: no issues found in 1 source file\n\n");
    expect(found).toEqual([]);
  });

  it("reads bandit's single JSON document and keeps the rule id and severity", () => {
    const found = extract("bandit", fixture("bandit.json"));
    expect(found).toHaveLength(2);
    expect(found[0]?.rule_id).toBe("B404");
    expect(found[0]?.severity).toBe("info"); // LOW -> info, so it is not ranked with errors
    expect(found[1]?.rule_id).toBe("B605");
    expect(found[1]?.severity).toBe("error"); // HIGH
    expect(found[1]?.line).toBe(6);
    expect(found[1]?.message).toMatch(/^start_process_with_a_shell: /);
    expect(found[0]?.json_pointer).toBe("/results/0");
  });

  it("reads ruff's JSON array", () => {
    const found = extract("ruff", fixture("ruff.json"));
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.rule_id)).toEqual(["UP045", "F541"]);
    expect(found[0]?.category).toBe("lint_correctness");
    expect(found[0]?.line).toBe(6);
    expect(found[0]?.json_pointer).toBe("/0");
  });

  it("normalizes ruff's absolute paths and bandit's ./ prefix before merging", () => {
    const root = join("/scanned", "repo");
    const rows = normalizePaths(
      [
        { ...finding("ruff", "UP045", join(root, "app/x.py"), 6) },
        { ...finding("bandit", "B605", "./app/y.py", 9) },
      ],
      root,
    );
    expect(rows.map((f) => f.path)).toEqual(["app/x.py", "app/y.py"]);
    expect(rows[0]?.dedupe_key).toBe(dedupeKey("app/x.py", 6, "lint_correctness"));
  });

  it("collapses the same ruff defect reported by aislop and by standalone ruff", () => {
    const root = "/scanned/repo";
    const rows = normalizePaths(
      [
        { ...finding("aislop", "ruff/F401", "app/x.py", 9) },
        { ...finding("ruff", "F401", join(root, "app/x.py"), 9) },
      ],
      root,
    );
    const merged = mergeDuplicates(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.tools).toEqual(["aislop", "ruff"]);
  });

  it("rejects a non-array ruff payload rather than reporting zero findings", () => {
    expect(() => extract("ruff", '{"results":[]}')).toThrow(/not a JSON array/);
  });

  it("counts bandit's per-file metrics as files scanned", () => {
    expect(reportedFileCount("bandit", fixture("bandit.json"))).toEqual({
      reported: 1,
      source: "metrics (one entry per file)",
    });
    // mypy and ruff report no file count in JSON: null, never a guess.
    expect(reportedFileCount("mypy", fixture("mypy.jsonl")).reported).toBeNull();
    expect(reportedFileCount("ruff", fixture("ruff.json")).reported).toBeNull();
  });

  it("fails loudly instead of returning zero findings on malformed output", () => {
    expect(() => extract("biome", "not json")).toThrow(/not JSON/);
    expect(() => extract("nope", "{}")).toThrow(/no extractor/);
  });
});

describe("dedupe", () => {
  const finding = (tool: string, path: string, line: number, category: string) => {
    const [built] = toFindings(
      { id: tool, version: "1" },
      [
        {
          rule_id: "r",
          category: category as never,
          severity: "warning",
          path,
          line,
          message: "m",
          json_pointer: "/x/0",
        },
      ],
      "raw/x.json",
      0,
    );
    if (built === undefined) throw new Error("toFindings produced nothing");
    return built;
  };

  it("buckets lines 4 apart into one key", () => {
    expect(dedupeKey("a.ts", 0, "duplication")).toBe(dedupeKey("a.ts", 3, "duplication"));
    expect(dedupeKey("a.ts", 0, "duplication")).not.toBe(dedupeKey("a.ts", 4, "duplication"));
    expect(dedupeKey("a.ts", 0, "duplication")).not.toBe(dedupeKey("a.ts", 0, "lint_style"));
  });

  it("merges the same location across tools but keeps same-tool instances", () => {
    const merged = mergeDuplicates([
      finding("knip", "a.ts", 10, "unused_file_export_dep"),
      finding("fallow", "a.ts", 10, "unused_file_export_dep"),
      finding("jscpd", "b.ts", 2, "duplication"),
      finding("jscpd", "b.ts", 2, "duplication"),
    ]);
    expect(merged).toHaveLength(3); // knip+fallow merged, both jscpd clones kept
    const crossTool = merged.find((f) => f.tools.length === 2);
    expect(crossTool?.tools).toEqual(["knip", "fallow"]);
    expect(merged.filter((f) => f.primary_tool === "jscpd")).toHaveLength(2);
  });

  it("derives ids from content, not from the analyzer's emission order", () => {
    const entries = [
      {
        rule_id: "exact",
        category: "duplication" as never,
        severity: "info" as never,
        path: "b.ts",
        line: 2,
        message: "first clone",
        json_pointer: "/duplicates/0",
      },
      {
        rule_id: "exact",
        category: "duplication" as never,
        severity: "info" as never,
        path: "b.ts",
        line: 2,
        message: "second clone",
        json_pointer: "/duplicates/1",
      },
    ];
    const forward = toFindings({ id: "jscpd", version: "1" }, entries, "raw/jscpd.json", 0);
    const reversed = toFindings(
      { id: "jscpd", version: "1" },
      [...entries].reverse(),
      "raw/jscpd.json",
      0,
    );
    expect(forward.map((f) => f.id).sort()).toEqual(reversed.map((f) => f.id).sort());
    // Same path, line and rule but different messages must still be distinct findings.
    expect(new Set(forward.map((f) => f.id)).size).toBe(2);
  });

  it("treats identical content in two raw entries as one finding", () => {
    const entry = {
      rule_id: "exact",
      category: "duplication" as never,
      severity: "info" as never,
      path: "b.ts",
      line: 2,
      message: "m",
      json_pointer: "/duplicates/0",
    };
    const [a] = toFindings({ id: "jscpd", version: "1" }, [entry], "raw/jscpd.json", 0);
    const [b] = toFindings(
      { id: "jscpd", version: "1" },
      [{ ...entry, json_pointer: "/duplicates/1" }],
      "raw/jscpd.json",
      0,
    );
    expect(a?.id).toBe(b?.id);
    expect(a?.provenance.json_pointer).toBe("/duplicates/0");
    expect(b?.provenance.json_pointer).toBe("/duplicates/1");
  });
});

describe("seeded sampling", () => {
  it("is reproducible for one seed and different across seeds", () => {
    const first = mulberry32(7);
    const second = mulberry32(7);
    const other = mulberry32(8);
    const a = [first(), first(), first()];
    const b = [second(), second(), second()];
    const c = [other(), other(), other()];
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe("run status is decided by the exit code, not the finding count", () => {
  it("never reports a killed process as clean", () => {
    expect(
      toolStatus({
        anyExecuted: true,
        failure: exitFailure(137),
        timedOut: false,
        findingCount: 0,
      }),
    ).toBe("failure");
    expect(exitFailure(137)).toBe("killed by signal 9 (exit 137)");
    expect(exitFailure(2)).toBe("exit 2");
  });

  it("keeps the ordinary cases", () => {
    expect(toolStatus({ anyExecuted: true, failure: null, timedOut: false, findingCount: 3 })).toBe(
      "success_with_findings",
    );
    expect(toolStatus({ anyExecuted: true, failure: null, timedOut: false, findingCount: 0 })).toBe(
      "clean",
    );
    expect(toolStatus({ anyExecuted: true, failure: null, timedOut: true, findingCount: 0 })).toBe(
      "timeout",
    );
    expect(
      toolStatus({
        anyExecuted: false,
        failure: "missing binary /x",
        timedOut: false,
        findingCount: 0,
      }),
    ).toBe("not_installed");
  });
});

describe("an invocation must have measured something", () => {
  it("flags a code outside the tool's allowed set, naming the signal", () => {
    expect(exitProblem({ code: 137, allowed: [0, 1], parsed: 0, timedOut: false })).toBe(
      "killed by signal 9 (exit 137)",
    );
    expect(exitProblem({ code: 2, allowed: [0, 1], parsed: 5, timedOut: false })).toBe("exit 2");
  });

  it("accepts tsc's exit 2 when it parsed findings, because 2 is how tsc reports type errors", () => {
    expect(exitProblem({ code: 2, allowed: [0, 2], parsed: 12, timedOut: false })).toBeNull();
  });

  it("rejects an allowed non-zero code that produced nothing, as with a project that will not compile", () => {
    expect(exitProblem({ code: 2, allowed: [0, 2], parsed: 0, timedOut: false })).toBe(
      "exit 2 with no findings parsed",
    );
  });

  it("treats a clean exit as fine whether or not it found anything", () => {
    expect(exitProblem({ code: 0, allowed: [0], parsed: 0, timedOut: false })).toBeNull();
    expect(exitProblem({ code: 0, allowed: [0], parsed: 40, timedOut: false })).toBeNull();
    expect(exitProblem({ code: null, allowed: [0], parsed: 0, timedOut: true })).toBeNull();
  });
});
