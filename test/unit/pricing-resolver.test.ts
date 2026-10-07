/**
 * Unit tests for the pricing resolver.
 */
import { describe, expect, it } from "vitest";
import { isFreeCost } from "../../src/budget/pricing-resolver";

describe("isFreeCost", () => {
  it("true when input and output are both zero", () => {
    expect(isFreeCost({ input: 0, output: 0 })).toBe(true);
  });

  it("false when input is priced", () => {
    expect(isFreeCost({ input: 0.14, output: 0 })).toBe(false);
  });

  it("false when output is priced", () => {
    expect(isFreeCost({ input: 0, output: 0.28 })).toBe(false);
  });
});
