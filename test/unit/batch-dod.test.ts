/**
 * Unit tests for batch DoD normalization: the gate folds only a criterion
 * label, backticks, curly quotes, en/em dashes and whitespace
 * (src/supervisor/finalization.ts), so every other markdown construct must be
 * removed here or a run fails `criteria` after it has been paid for.
 */
import { describe, expect, it } from "vitest";
import { normalizeDoD } from "../../src/batch/dod";
import { criteriaMismatches } from "../../src/supervisor/finalization";

const X = "The closing sequence has one owner";
const pass = (criterion: string) =>
  criteriaMismatches([{ criterion, result: "pass", evidence: "test" }], [criterion]);

describe("normalizeDoD", () => {
  it("strips structural prefixes", () => {
    const raw = [
      `- [ ] ${X}`,
      `- ${X}`,
      `* ${X}`,
      `1. ${X}`,
      `1) ${X}`,
      `1: ${X}`,
      `## ${X}`,
      `> ${X}`,
      `- [ ] 1. ${X}`,
    ];
    expect(normalizeDoD(raw).criteria).toEqual(raw.map(() => X));
  });

  it("keeps an inline code span literal, so two globs survive (#311)", () => {
    // Two asterisks in a criterion look exactly like `*...*` emphasis; the live
    // failure turned `*.jsonl` under `sessions/*/` into `.jsonl` under `sessions//`.
    const raw = "picks the newest `*.jsonl` under `~/.pi/agent/sessions/*/`";
    const out = normalizeDoD([raw]);
    expect(out.criteria).toEqual([raw]);
    expect(out.problems).toEqual([]);
  });

  it("folds emphasis that wraps a code span, and an unbalanced backtick refuses (#313)", () => {
    // The span split decides what is prose: a naive even/odd split also decided whether
    // emphasis folds, and turned an unmatched backtick into a silent pass.
    const cases: [string, string, string | undefined][] = [
      ["strong wrapping a span", "**`code`**", "`code`"],
      ["emphasis wrapping a span", "a *`x`* b", "a `x` b"],
      ["brackets across a span", "a]`x`(y)", "a]`x`(y)"],
      ["unmatched backtick", "unbalanced `tick and **bold**", undefined],
    ];
    for (const [label, raw, expected] of cases) {
      const out = normalizeDoD([raw]);
      expect(out.criteria, label).toEqual([expected ?? raw]);
      expect(
        out.problems.map((p) => p.reason),
        label,
      ).toEqual(expected === undefined ? ["markdown"] : []);
    }
  });

  it("round-trips a glob-bearing criterion through the finalize gate (#313)", () => {
    // The gap #311's fix left open: a criterion that survives normalization must also be
    // accepted verbatim by the gate, or the run fails after it has been paid for.
    const raw = "picks the newest `*.jsonl` under `~/.pi/agent/sessions/*/`";
    const [criterion] = normalizeDoD([raw]).criteria;
    expect(pass(criterion as string)).toEqual([]);
  });

  it("still folds emphasis around and outside code spans", () => {
    const raw = "**a bold rule** and *an emphasis* with `*literal*`";
    const out = normalizeDoD([raw]);
    expect(out.criteria).toEqual(["a bold rule and an emphasis with `*literal*`"]);
    expect(out.problems).toEqual([]);
  });

  it("does not report a markdown residual that sits inside a code span", () => {
    // A literal `**` in code is not leftover markdown; prose-only is what the check reads.
    const out = normalizeDoD(["match `a**b` in the tree"]);
    expect(out.criteria).toEqual(["match `a**b` in the tree"]);
    expect(out.problems).toEqual([]);
  });

  it("strips emphasis, links, images and html", () => {
    const raw = [
      `**${X}**`,
      `*${X}*`,
      `_${X}_`,
      `__${X}__`,
      `[${X}](https://example.com)`,
      `<b>${X}</b>`,
    ];
    expect(normalizeDoD(raw).criteria).toEqual(raw.map(() => X));
    expect(normalizeDoD([`![alt text](https://example.com/i.png)`]).criteria).toEqual(["alt text"]);
  });

  it("leaves what the gate already folds, and identifiers, untouched", () => {
    const raw = [
      "The `run_state` field stays authoritative",
      "It’s “done” when the snapshot exists",
      "A — B is the same as A - B",
      `C1 — ${X}`,
      `criterion 2: ${X}`,
      "snake_case_names keep their underscores",
      "a*b*c is not emphasis",
    ];
    expect(normalizeDoD(raw).criteria).toEqual(raw);
  });

  it("refuses a table row and residual markdown instead of guessing", () => {
    const { criteria, problems } = normalizeDoD([`| ${X} | yes |`, `**${X}`, ""]);
    expect(criteria).toHaveLength(3);
    expect(problems.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(problems.map((p) => p.reason)).toEqual(["table", "markdown", "empty"]);
  });

  it("normalization is necessary: the raw form would fail the gate", () => {
    const raws = [
      `- [ ] ${X}`,
      `- ${X}`,
      `* ${X}`,
      `1. ${X}`,
      `1) ${X}`,
      `1: ${X}`,
      `## ${X}`,
      `> ${X}`,
      `**${X}**`,
      `*${X}*`,
      `_${X}_`,
      `__${X}__`,
      `[${X}](https://example.com)`,
      `<b>${X}</b>`,
    ];
    const { criteria } = normalizeDoD(raws);
    raws.forEach((raw, i) => {
      const normalized = criteria[i] ?? "";
      expect(pass(normalized), `normalized ${i} must pass`).toEqual([]);
      expect(
        criteriaMismatches([{ criterion: normalized, result: "pass", evidence: "test" }], [raw]),
      ).toHaveLength(1);
    });
  });

  it("does not over-normalize: a reworded criterion still mismatches", () => {
    const { criteria } = normalizeDoD([`- [ ] ${X}`]);
    expect(
      criteriaMismatches(
        [
          {
            criterion: "the closing sequence has a single owner",
            result: "pass",
            evidence: "test",
          },
        ],
        criteria,
      ),
    ).toHaveLength(1);
  });

  it("does not mutate the input and keeps index alignment", () => {
    const raw = [`- ${X}`, `- ${X}!`];
    const copy = [...raw];
    const { criteria } = normalizeDoD(raw);
    expect(raw).toEqual(copy);
    expect(criteria).toHaveLength(2);
    expect(criteria[1]).toBe(`${X}!`);
  });
});
