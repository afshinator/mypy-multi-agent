import { describe, expect, it } from "vitest";
import { peerStatus } from "../../src/runtime/peer-status";

describe("peerStatus (issue #4)", () => {
  it("reports a busy peer and its progress age", () => {
    expect(peerStatus("a", "WORKING", 1_000, false, 4_500)).toEqual({
      agentId: "a",
      state: "WORKING",
      busy: true,
      progressAgeMs: 3_500,
      stalled: false,
    });
  });

  it("reports an idle peer with no age", () => {
    expect(peerStatus("a", "IDLE", undefined, false, 9_000)).toEqual({
      agentId: "a",
      state: "IDLE",
      busy: false,
      progressAgeMs: null,
      stalled: false,
    });
  });

  it("carries the stalled flag and never reports a negative age", () => {
    const status = peerStatus("a", "WORKING", 5_000, true, 4_000);
    expect(status.stalled).toBe(true);
    expect(status.progressAgeMs).toBe(0);
  });
});
