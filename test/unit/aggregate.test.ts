import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/scorecard/aggregate";
import type { RunScorecard } from "../../src/scorecard/scorecard";

const base: RunScorecard = {
  taxonomyVersion: "1.0",
  outcome: "success",
  exitCode: 0,
  outcomeExitMismatch: false,
  dod: "met",
  falseSuccess: false,
  turnDurationsMs: {},
  toolTimeMs: 0,
  toolTimeByAgentMs: {},
  toolCalls: 0,
  toolErrors: 0,
  retries: 0,
  correlationTimeouts: 0,
  agentCrashed: 0,
  agentUnusable: 0,
  agentStalled: 0,
  stopAgentReasons: {},
  cost: {
    totalCostUsd: null,
    totalTokens: null,
    supervisorCostUsd: null,
    supervisorTokens: null,
    agents: [],
  },
  modelRoster: [],
  mistakes: [],
};

const make = (over: Partial<RunScorecard> = {}): RunScorecard => ({
  ...base,
  ...over,
  cost: { ...base.cost, ...(over.cost ?? {}) },
});

describe("aggregate", () => {
  it("ranks mistake classes by frequency and rate, worst first", () => {
    const cards = [
      make({
        mistakes: [
          { class: "M1", detail: "a" },
          { class: "M2", detail: "b" },
        ],
      }),
      make({ mistakes: [{ class: "M1", detail: "c" }] }),
      make(),
    ];

    const trends = aggregate(cards);
    expect(trends.scorecardCount).toBe(3);
    expect(trends.byVersion).toHaveLength(1);
    expect(trends.byVersion[0]).toMatchObject({ taxonomyVersion: "1.0", scorecardCount: 3 });
    expect(trends.byVersion[0]?.mistakes).toEqual([
      { class: "M1", count: 2, rate: 2 / 3 },
      { class: "M2", count: 1, rate: 1 / 3 },
    ]);
  });

  it("groups mixed taxonomy versions and never compares across them", () => {
    const cards = [
      make({ taxonomyVersion: "1.0", mistakes: [{ class: "M1", detail: "a" }] }),
      make({ taxonomyVersion: "2.0", mistakes: [{ class: "M2", detail: "b" }] }),
    ];

    const trends = aggregate(cards);
    expect(trends.scorecardCount).toBe(2);
    expect(trends.byVersion.map((v) => v.taxonomyVersion)).toEqual(["1.0", "2.0"]);
    expect(trends.byVersion[0]?.mistakes).toEqual([{ class: "M1", count: 1, rate: 1 }]);
    expect(trends.byVersion[1]?.mistakes).toEqual([{ class: "M2", count: 1, rate: 1 }]);
  });

  it("does not mutate its input", () => {
    const cards = [make({ mistakes: [{ class: "M1", detail: "a" }] })];
    const snapshot = JSON.stringify(cards);
    aggregate(cards);
    expect(JSON.stringify(cards)).toBe(snapshot);
  });
});
