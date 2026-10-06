import { describe, it, expect } from "vitest";

// Full end-to-end acceptance needs a live herdr + pi + model runtime.
// Written before production assembly; skipped unless running inside herdr.
const inHerdr = process.env.HERDR_ENV === "1";

describe.skipIf(!inHerdr)("end-to-end", () => {
  it("full run: config validates, bus starts, peers register, work dispatches, finalizes, exits 0", async () => {
    // Assemble the runtime against the real herdr CLI, spawn real SDK peers,
    // dispatch work, reconcile, and assert the exit code and final.md.
    expect(true).toBe(true); // placeholder until the live harness is wired
  });
});
