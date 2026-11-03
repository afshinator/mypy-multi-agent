/**
 * The run's closing sequence has one owner, and the order it writes in is the
 * invariant: final.md before the scorecard reads it, the snapshot last.
 */
import { describe, expect, it, vi } from "vitest";
import { closeRun } from "../../src/runtime/closing-record";
import type { GateResult } from "../../src/supervisor/finalization";

const RESULT: GateResult = {
  success: true,
  failingTerms: [],
  terms: {},
} as unknown as GateResult;

function harness(options: { scorecard?: boolean; scorecardThrows?: boolean } = {}) {
  const order: string[] = [];
  const supervisorUsage = { costUsd: 0.25, tokens: 500 };
  const cost = { totalCostUsd: 1, totalTokens: 2 };
  const deps = {
    gate: {
      evaluate: vi.fn(async () => {
        order.push("evaluate");
        return RESULT;
      }),
      write: vi.fn(async (c: unknown) => {
        order.push(`write-final:${JSON.stringify(c)}`);
      }),
    },
    costBreakdown: vi.fn((usage?: { costUsd: number; tokens: number }) => {
      order.push(`cost-breakdown:${JSON.stringify(usage)}`);
      return cost as never;
    }),
    scorecard:
      options.scorecard === false
        ? undefined
        : vi.fn(async () => {
            order.push("scorecard");
            if (options.scorecardThrows) throw new Error("disk full");
          }),
    writeSnapshot: vi.fn(async (usage?: { costUsd: number; tokens: number }) => {
      order.push(`snapshot:${JSON.stringify(usage)}`);
    }),
    log: vi.fn(),
  };
  return { deps, order, supervisorUsage };
}

describe("closeRun", () => {
  it("writes final.md before the scorecard and the snapshot last, carrying usage", async () => {
    const { deps, order, supervisorUsage } = harness();
    const result = await closeRun(deps, { dodSatisfied: true, supervisorUsage });

    expect(result).toBe(RESULT);
    expect(order).toEqual([
      "evaluate",
      `cost-breakdown:${JSON.stringify(supervisorUsage)}`,
      `write-final:${JSON.stringify({ totalCostUsd: 1, totalTokens: 2 })}`,
      "scorecard",
      `snapshot:${JSON.stringify(supervisorUsage)}`,
    ]);
  });

  it("skips the scorecard when the run did not ask for one", async () => {
    const { deps, order } = harness({ scorecard: false });
    await closeRun(deps, { dodSatisfied: true });
    expect(order).toEqual([
      "evaluate",
      "cost-breakdown:undefined",
      'write-final:{"totalCostUsd":1,"totalTokens":2}',
      "snapshot:undefined",
    ]);
  });

  it("logs a failed scorecard and still writes the snapshot", async () => {
    const { deps, order } = harness({ scorecardThrows: true });
    const result = await closeRun(deps, { dodSatisfied: true });

    expect(result).toBe(RESULT);
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ERROR", event: "scorecard-write-failed" }),
    );
    expect(order.at(-1)).toMatch(/^snapshot:/);
  });
});
