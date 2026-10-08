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

  it("returns undefined when an entry fails the schema", () => {
    const bad = JSON.stringify([{ criterion: "a", result: "maybe", evidence: "x" }]);
    expect(parseCriteriaBlock(`\`\`\`json\n${bad}\n\`\`\``)).toBeUndefined();
  });
});
