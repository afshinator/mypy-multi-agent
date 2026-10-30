/**
 * Unit tests for the reviewer criterion-verdict contract.
 */
import { describe, expect, it } from "vitest";
import { parseCriteriaBlock } from "../../src/contracts/criteria";

const good = [{ criterion: "a", result: "pass", evidence: "file:1" }];

describe("parseCriteriaBlock", () => {
  it("parses a fenced JSON array", () => {
    expect(
      parseCriteriaBlock(`assessment here\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``),
    ).toEqual(good);
  });

  it("parses a fenced { criteria: [...] } object", () => {
    expect(parseCriteriaBlock(`\`\`\`json\n${JSON.stringify({ criteria: good })}\n\`\`\``)).toEqual(
      good,
    );
  });

  it("returns undefined without a fenced json block", () => {
    expect(parseCriteriaBlock(JSON.stringify(good))).toBeUndefined();
  });

  it("returns undefined on malformed JSON", () => {
    expect(parseCriteriaBlock("```json\n[{oops}]\n```")).toBeUndefined();
  });

  it("returns undefined for an empty block (a placeholder is not an attestation)", () => {
    expect(parseCriteriaBlock("```json\n[]\n```")).toBeUndefined();
    expect(parseCriteriaBlock('```json\n{"criteria":[]}\n```')).toBeUndefined();
  });

  it("returns undefined when an entry fails the schema", () => {
    const bad = JSON.stringify([{ criterion: "a", result: "maybe", evidence: "x" }]);
    expect(parseCriteriaBlock(`\`\`\`json\n${bad}\n\`\`\``)).toBeUndefined();
  });
});

describe("parseCriteriaBlock verdict values", () => {
  // StrykerJS survived replacing a member of the result enum: no test parsed a
  // failing verdict, so the only exercising path was "pass".
  it("parses a failing verdict", () => {
    const block = [{ criterion: "a", result: "fail", evidence: "src/x.ts:9" }];
    expect(parseCriteriaBlock(`\`\`\`json\n${JSON.stringify(block)}\n\`\`\``)).toEqual(block);
  });
});
