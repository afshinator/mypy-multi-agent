/**
 * Unit tests for the supervisor usage module.
 */
import { describe, expect, it } from "vitest";
import { sumSupervisorUsage } from "../../src/pi/supervisor-usage";

const msg = (role: string, usage?: { cost?: number; totalTokens?: number }) => ({
  type: "message",
  id: "m",
  parentId: null,
  timestamp: "t",
  message: {
    role,
    usage: usage ? { cost: { total: usage.cost ?? 0 }, totalTokens: usage.totalTokens ?? 0 } : undefined,
  },
});

describe("sumSupervisorUsage", () => {
  it("sums assistant message cost and tokens", () => {
    const entries = [
      msg("user"),
      msg("assistant", { cost: 0.25, totalTokens: 1000 }),
      msg("assistant", { cost: 0.75, totalTokens: 3000 }),
    ];
    expect(sumSupervisorUsage(entries as never)).toEqual({ costUsd: 1.0, tokens: 4000 });
  });

  it("ignores non-assistant and non-message entries", () => {
    const entries = [
      msg("user", { cost: 5, totalTokens: 999 }),
      { type: "usage", id: "u", parentId: null, timestamp: "t", kind: "k", provider: "p", model: "m", usage: { cost: { total: 99 }, totalTokens: 99 } },
    ];
    expect(sumSupervisorUsage(entries as never)).toEqual({ costUsd: 0, tokens: 0 });
  });

  it("treats missing usage as zero", () => {
    expect(sumSupervisorUsage([msg("assistant")] as never)).toEqual({ costUsd: 0, tokens: 0 });
  });
});
