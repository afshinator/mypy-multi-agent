/**
 * The citation-form check (#122). Criterion 1 of the post-mortem template asks
 * for a path under a target run and a location; a locator on a bare file name is
 * the defect. This rule is deliberately narrow: it does not try to decide whether
 * a cited location supports its claim, and it does not flag an anchored path that
 * carries no locator (that class needs section awareness, and false positives on
 * legitimate locator-free lists would cost the check its credibility).
 */
import { describe, expect, it } from "vitest";
import { findBareCitations } from "../../scripts/check-citations";

const tokens = (text: string) => findBareCitations(text).map((f) => f.token);

describe("findBareCitations", () => {
  it("flags a locator on a bare file name", () => {
    expect(tokens("see `tool-calls.jsonl:16-17` for the records")).toEqual(["tool-calls.jsonl:16"]);
    expect(tokens("`spans.jsonl:1-132` has the timeline")).toEqual(["spans.jsonl:1"]);
  });

  it("accepts a path under a target run", () => {
    expect(tokens("`mypi-tasks/04-inspector-server/run-details/tool-calls.jsonl:16-17`")).toEqual(
      [],
    );
    expect(tokens("`/Users/afshin/Documents/dev/multi-agent/mypi-tasks/r1-fixes/x.md:4`")).toEqual(
      [],
    );
  });

  it("counts a range or list locator once, at its first number", () => {
    expect(tokens("`tool-calls.jsonl:46,47,50,51`")).toEqual(["tool-calls.jsonl:46"]);
  });

  it("does not flag dotted identifiers that are not artifact names", () => {
    expect(tokens("`ask.definition_of_done:1`, `peer.turn:2`, `supervisor.dispatch:3`")).toEqual(
      [],
    );
  });

  it("does not read a hyphenated name as two names", () => {
    // The hyphen in the negated lookbehind is load-bearing: without it
    // `run-state.json:1` also matches as `state.json:1`.
    expect(tokens("`run-state.json:1`")).toEqual(["run-state.json:1"]);
  });

  it("does not flag a path-like name with no locator", () => {
    expect(tokens("`final.md` and `findings-summary.md` are named without a line")).toEqual([]);
  });

  it("reports the line of the document, not the line of the citation", () => {
    const text = ["# Title", "", "a finding at `final.md:36`", "", "another at `plan.md:4`"].join(
      "\n",
    );
    expect(findBareCitations(text).map((f) => f.line)).toEqual([3, 5]);
  });
});
