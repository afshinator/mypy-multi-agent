import { describe, expect, it } from "vitest";
import { canTransition, transition } from "../../src/runtime/state-machine";

describe("state-machine", () => {
  it("valid transitions", () => {
    const valid = [
      ["STARTING", "PENDING"],
      ["PENDING", "WORKING"],
      ["WORKING", "WAITING"],
      ["WORKING", "DONE"],
      ["WAITING", "WORKING"],
      ["DONE", "WORKING"],
      ["WORKING", "CRASHED"],
      ["PENDING", "STOPPED"],
    ] as const;
    for (const [from, to] of valid) {
      expect(canTransition(from, to), `${from}->${to}`).toBe(true);
    }
  });

  it("invalid transitions", () => {
    const invalid = [
      ["STARTING", "WORKING"],
      ["PENDING", "DONE"],
      ["DONE", "PENDING"],
      ["CRASHED", "WORKING"],
      ["STOPPED", "WORKING"],
      ["WORKING", "WORKING"],
      ["DONE", "STARTING"],
    ] as const;
    for (const [from, to] of invalid) {
      expect(canTransition(from, to), `${from}->${to}`).toBe(false);
    }
  });

  it("transition throws on invalid", () => {
    expect(() => transition("CRASHED", "WORKING")).toThrow();
  });
});
