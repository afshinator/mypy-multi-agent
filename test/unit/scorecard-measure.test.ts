/**
 * One measurement for the cards' numbers (#167): the trend line and the
 * before/after table read the same mean from the same rule.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/scorecard/aggregate";
import { measureImprovement } from "../../src/scorecard/improvements";
import { measure } from "../../src/scorecard/measure";
import type { RunScorecard } from "../../src/scorecard/scorecard";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const card = (rounds?: number, cls?: "M1"): RunScorecard =>
  ({
    taxonomyVersion: "2.0",
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
      totalCostUsd: 0,
      totalTokens: 0,
      supervisorCostUsd: 0,
      supervisorTokens: 0,
      agents: [],
    },
    modelRoster: [],
    mistakes: cls === undefined ? [] : [{ class: cls, detail: "d" }],
    ...(rounds === undefined ? {} : { attestationRounds: rounds }),
  }) as RunScorecard;

describe("measure", () => {
  it("skips a card that does not carry the value — absent is not zero", () => {
    const cards = [card(2), card(undefined), card(4)];
    expect(measure(cards, (c) => c.attestationRounds)).toEqual({
      scorecards: 3,
      measured: 2,
      sum: 6,
      mean: 3,
    });
  });

  it("reports a null mean rather than zero when nothing carries the value", () => {
    expect(measure([card(undefined)], (c) => c.attestationRounds).mean).toBeNull();
  });

  it("turns a class into the same number a metric produces", () => {
    const cards = [card(2, "M1"), card(4)];
    const asClass = measure(cards, (c) => (c.mistakes.some((m) => m.class === "M1") ? 1 : 0));
    expect(asClass.sum).toBe(1);
    expect(asClass.mean).toBe(0.5);
  });
});

describe("one mean, two consumers", () => {
  it("the trend line and the improvement table agree for the same cards", () => {
    const cards = [card(1), card(3), card(undefined), card(5)];
    const trend = aggregate(cards).byVersion[0]!.attestation;
    const table = measureImprovement(
      {
        change: "x",
        metric: "attestationRounds",
        taxonomyVersion: "2.0",
        beforeCount: 0,
        afterCount: cards.length,
      },
      cards,
    ).after;

    expect(trend?.meanRounds).toBe(table.rate);
    expect(trend?.cards).toBe(table.count);
  });
});

describe("no second implementation", () => {
  it("both consumers import the one measurement, and neither re-derives a mean", () => {
    const read = (name: string) => readFileSync(join(repoRoot, "src/scorecard", name), "utf8");
    for (const file of ["aggregate.ts", "improvements.ts"]) {
      expect(read(file)).toContain('from "./measure"');
      expect(read(file)).not.toMatch(/reduce\(\(s(um)?, /);
    }
  });
});
