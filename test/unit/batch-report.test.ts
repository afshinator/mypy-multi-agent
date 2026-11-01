/**
 * Fixtures are authored to the format the two prompts fix
 * (docs/explorations/triage-automation/triage-prompt.md:97-114,
 * triage-verifier.md:60-66): no literal reply is recorded anywhere in the repo,
 * so these are spec-shaped, not captured. The first real cycle is where the
 * parser meets real output.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acceptance, parseTriageReport, parseVerifierBlock } from "../../src/batch/report";

const REPLY = `## Claim checks
| claim | command | observed | verdict |
| --- | --- | --- | --- |
| The gate folds backticks | \`sed -n '66,85p' src/supervisor/finalization.ts\` | fold() strips backticks | true |
| Both helpers are used | \`rg -n "criteriaMismatches|normalizeDoD" src/\` | one hit | partial |
| Nothing exits pi | \`rg -n "process\\.exit" src/pi/\` | no output | true |

## Need
The gate compares after folding.

## Fix
Normalize before writing.

## Definition of Done
1. \`normalizeDoD\` strips a checkbox from \`- [ ] x\` — proven by \`bun run test test/unit/batch-dod.test.ts\`
2. A manifest survives serialization and re-parses
   with the same criteria.

## Verdict
\`run\` — two modules change.

## Open questions
none
`;

const NO_DOD = `## Claim checks
| claim | command | observed | verdict |
| --- | --- | --- | --- |
| The fix is upstream | \`sed -n '184p' web/edit-diff.js\` | the guard is already there | true |

## Need
Upstream owns it.

## Fix
Cannot reach it.

## Definition of Done
No DoD: N2 the fix cannot reach the failing path

## Verdict
no DoD

## Open questions
none
`;

function block(entries: string, tail = "could-not-run: none"): string {
  return `\`\`\`json\n${entries}\n\`\`\`\n\n${tail}\n`;
}

describe("parseTriageReport", () => {
  it("reads the claim rows, criteria and verdict", () => {
    const report = parseTriageReport(REPLY);

    expect(report.claims).toHaveLength(3);
    expect(report.claims.map((c) => c.verdict)).toEqual(["true", "partial", "true"]);
    expect(report.claims[1]?.verdict).toBe("partial");
    expect(report.criteria).toHaveLength(2);
    expect(report.verdict).toBe("run");
  });

  it("keeps the table verbatim for the verifier prompt", () => {
    expect(parseTriageReport(REPLY).claimsText).toContain(
      'rg -n "criteriaMismatches|normalizeDoD" src/',
    );
  });

  it("splits cells on unescaped pipes outside code spans only", () => {
    const [first, second] = parseTriageReport(REPLY).claims;
    // The pipe inside the backticks did not split the row.
    expect(first?.command).toBe("sed -n '66,85p' src/supervisor/finalization.ts");
    expect(second?.command).toBe('rg -n "criteriaMismatches|normalizeDoD" src/');
    expect(second?.observed).toBe("one hit");
  });

  it("reads a backslash-escaped pipe as a literal", () => {
    const reply = REPLY.replace("| one hit |", "| a \\| b |");
    const row = parseTriageReport(reply).claims[1];
    expect(row?.observed).toBe("a | b");
  });

  it("joins a wrapped criterion instead of truncating it", () => {
    const [, second] = parseTriageReport(REPLY).criteria;
    expect(second).toBe("A manifest survives serialization and re-parses with the same criteria.");
  });

  it("reads inline and no-DoD verdicts", () => {
    expect(parseTriageReport(REPLY.replace("`run` —", "`inline` —")).verdict).toBe("inline");

    const report = parseTriageReport(NO_DOD);
    expect(report.verdict).toBe("no-dod");
    expect(report.criteria).toEqual([]);
    expect(report.noDod).toEqual({ code: "N2", reason: "the fix cannot reach the failing path" });
  });

  it("reads the KIND answer, and leaves it absent when the reply has none", () => {
    expect(parseTriageReport(REPLY).kind).toBeUndefined();
    expect(parseTriageReport(`${REPLY}\nKIND: code-fix\n`).kind).toBe("code-fix");
    expect(parseTriageReport(`${REPLY}\n\`KIND: inline\`\n`).kind).toBe("inline");
  });

  it("refuses a reply with no claim rows", () => {
    const headless = REPLY.replace(/\| claim[\s\S]*?no output \| true \|\n/, "");
    expect(() => parseTriageReport(headless)).toThrow(/no claim rows/);
  });

  it("refuses a row whose cells do not add up, instead of dropping it", () => {
    const ragged = REPLY.replace("| one hit |", "| one hit |");
    const broken = ragged.replace(/^\| Both helpers.*$/m, "| Both helpers | `rg -n x` | one hit |");
    expect(() => parseTriageReport(broken)).toThrow(/claim row 2 has 3 cells/);
  });

  it("takes the first named verdict, so 'run, not inline' is a run", () => {
    expect(
      parseTriageReport(REPLY.replace("`run` — two modules change.", "run, not inline")).verdict,
    ).toBe("run");
  });

  it("refuses a reply missing a required section", () => {
    expect(() => parseTriageReport(REPLY.replace("## Verdict", "## Outcome"))).toThrow(/Verdict/);
  });
});

describe("parseTriageReport on recorded replies", () => {
  // Captured from real triage runs (2026-11-01): two tickets, two providers. The
  // spec-shaped fixtures above can drift from what a model actually writes; these cannot.
  // `.txt`, not `.md`: the formatter would rewrite the recorded table.
  const recorded = ["test/fixtures/batch/triage-169.txt", "test/fixtures/batch/triage-200.txt"];

  for (const path of recorded) {
    it(`parses ${path}`, () => {
      const report = parseTriageReport(readFileSync(path, "utf8"));

      expect(report.claims.length).toBeGreaterThanOrEqual(5);
      expect(report.criteria.length).toBeGreaterThanOrEqual(3);
      expect(report.kind).toBe("inline");
      expect(report.verdict).toBe("inline");
      // Every claim row must carry a command: a row without one is unverifiable by construction.
      for (const claim of report.claims) expect(claim.command).not.toBe("");
    });
  }
});

describe("parseVerifierBlock", () => {
  const rows = [
    `{ "row": 1, "verdict": "match", "evidence": "fold() strips backticks" }`,
    `{ "row": 2, "verdict": "match", "evidence": "one hit" }`,
    `{ "row": 3, "verdict": "match", "evidence": "no output" }`,
  ];

  it("reads one entry per row and a clean could-not-run line", () => {
    const parsed = parseVerifierBlock(block(`[${rows.join(",")}]`));
    expect(parsed.verdicts.map((v) => v.row)).toEqual([1, 2, 3]);
    expect(parsed.couldNotRun).toEqual([]);
  });

  it("reads a named could-not-run list", () => {
    const parsed = parseVerifierBlock(block(`[${rows.join(",")}]`, "could-not-run: rows 1,3"));
    expect(parsed.couldNotRun).toEqual([1, 3]);
  });

  it("refuses text without a fenced json block", () => {
    expect(() => parseVerifierBlock("all good!\n")).toThrow(/fenced/);
  });
});

describe("acceptance", () => {
  const report = parseTriageReport(REPLY);
  const rows = report.claims.map(
    (_c, i) => `{ "row": ${i + 1}, "verdict": "match", "evidence": "seen" }`,
  );

  it("accepts a clean block", () => {
    expect(acceptance(report, parseVerifierBlock(block(`[${rows.join(",")}]`)))).toEqual({
      ok: true,
    });
  });

  it("refuses a mismatch", () => {
    const dirty = rows.map((r, i) => (i === 1 ? r.replace('"match"', '"mismatch"') : r));
    const verdict = acceptance(report, parseVerifierBlock(block(`[${dirty.join(",")}]`)));
    expect(verdict).toMatchObject({ ok: false, code: "verifier-mismatch" });
  });

  it("refuses a could-not-run row even when every verdict is a match", () => {
    const verdict = acceptance(
      report,
      parseVerifierBlock(block(`[${rows.join(",")}]`, "could-not-run: rows 2")),
    );
    expect(verdict).toMatchObject({ ok: false, code: "verifier-mismatch" });
  });

  it("refuses a block whose row count disagrees with the report", () => {
    const verdict = acceptance(
      report,
      parseVerifierBlock(block(`[${rows.slice(0, 2).join(",")}]`)),
    );
    expect(verdict).toMatchObject({ ok: false, code: "unverifiable" });
  });

  it("refuses a block that repeats or reorders rows", () => {
    const repeated = [rows[0], rows[0], rows[2]].join(",");
    const verdict = acceptance(report, parseVerifierBlock(block(`[${repeated}]`)));
    expect(verdict).toMatchObject({ ok: false, code: "unverifiable" });
  });

  it("refuses a report with no claim rows, so an empty set cannot pass vacuously", () => {
    const empty = { ...report, claims: [] };
    const verdict = acceptance(empty, parseVerifierBlock(block("[]")));
    expect(verdict).toMatchObject({ ok: false, code: "unverifiable" });
  });
});
