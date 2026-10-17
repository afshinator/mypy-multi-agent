/**
 * Unit tests for the supervisor usage module.
 */
import { describe, expect, it } from "vitest";
import { sumSupervisorUsage } from "../../src/pi/supervisor-usage";

const msg = (
  role: string,
  usage?: { cost?: number; totalTokens?: number },
  timestamp = "2026-10-17T10:00:00.000Z",
) => ({
  type: "message",
  id: "m",
  parentId: null,
  timestamp,
  message: {
    role,
    usage: usage
      ? { cost: { total: usage.cost ?? 0 }, totalTokens: usage.totalTokens ?? 0 }
      : undefined,
  },
});

describe("sumSupervisorUsage", () => {
  it("sums assistant message cost and tokens after the run start", () => {
    const entries = [
      msg("user"),
      msg("assistant", { cost: 0.25, totalTokens: 1000 }),
      msg("assistant", { cost: 0.75, totalTokens: 3000 }),
    ];
    expect(sumSupervisorUsage(entries as never, 0)).toEqual({ costUsd: 1.0, tokens: 4000 });
  });

  it("ignores non-assistant and non-message entries", () => {
    const entries = [
      msg("user", { cost: 5, totalTokens: 999 }),
      {
        type: "usage",
        id: "u",
        parentId: null,
        timestamp: "2026-10-17T10:00:00.000Z",
        kind: "k",
        provider: "p",
        model: "m",
        usage: { cost: { total: 99 }, totalTokens: 99 },
      },
    ];
    expect(sumSupervisorUsage(entries as never, 0)).toEqual({ costUsd: 0, tokens: 0 });
  });

  it("treats missing usage as zero", () => {
    expect(sumSupervisorUsage([msg("assistant")] as never, 0)).toEqual({
      costUsd: 0,
      tokens: 0,
    });
  });

  it("excludes entries created before the run started", () => {
    const since = new Date("2026-10-17T11:00:00.000Z").getTime();
    const entries = [
      msg("assistant", { cost: 0.5, totalTokens: 100 }, "2026-10-17T10:00:00.000Z"),
      msg("assistant", { cost: 0.25, totalTokens: 500 }, "2026-10-17T11:00:00.000Z"),
      msg("assistant", { cost: 0.75, totalTokens: 1500 }, "2026-10-17T12:00:00.000Z"),
    ];
    expect(sumSupervisorUsage(entries as never, since)).toEqual({ costUsd: 1.0, tokens: 2000 });
  });
});
