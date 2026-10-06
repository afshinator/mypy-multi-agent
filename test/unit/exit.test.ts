import { describe, expect, it } from "vitest";
import { EXIT } from "../../src/runtime/exit";

describe("exit codes", () => {
  it("defines all four exit codes", () => {
    expect(EXIT.SUCCESS).toBe(0);
    expect(EXIT.FAILURE).toBe(1);
    expect(EXIT.USER_ABORTED).toBe(2);
    expect(EXIT.CONFIG_ERROR).toBe(3);
  });
});
