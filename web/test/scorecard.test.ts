import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseScorecard } from "../lib/scorecard";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseScorecard", () => {
  it("parses a valid scorecard.json into a typed RunScorecard", () => {
    const scorecard = parseScorecard(fixture("scorecard.json"));
    expect(scorecard).not.toBeNull();
    expect(scorecard?.taxonomyVersion).toBe("1.0");
    expect(scorecard?.outcome).toBe("success");
    expect(scorecard?.exitCode).toBe(0);
    expect(scorecard?.outcomeExitMismatch).toBe(false);
    expect(scorecard?.dod).toBe("met");
    expect(scorecard?.falseSuccess).toBe(false);
    expect(scorecard?.turnDurationsMs).toEqual({ implementer: [1931, 286773] });
    expect(scorecard?.toolTimeMs).toBe(1234);
    expect(scorecard?.toolTimeByAgentMs).toEqual({ implementer: 1200 });
    expect(scorecard?.toolCalls).toBe(3);
    expect(scorecard?.toolErrors).toBe(1);
    expect(scorecard?.retries).toBe(1);
    expect(scorecard?.correlationTimeouts).toBe(0);
    expect(scorecard?.agentCrashed).toBe(0);
    expect(scorecard?.agentUnusable).toBe(0);
    expect(scorecard?.agentStalled).toBe(0);
    expect(scorecard?.stopAgentReasons).toEqual({});
    expect(scorecard?.cost).toEqual({
      totalCostUsd: 0.46,
      totalTokens: 100,
      supervisorCostUsd: 0.1,
      supervisorTokens: 20,
      agents: [{ agentId: "implementer", costUsd: 0.36, tokens: 80 }],
    });
    expect(scorecard?.modelRoster).toEqual(["model-a"]);
    expect(scorecard?.mistakes).toEqual([{ class: "M2", detail: "outcome=success exitCode=1" }]);
  });

  it("returns null for invalid JSON", () => {
    expect(parseScorecard("not json")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseScorecard('{"taxonomyVersion":"1.0"}')).toBeNull();
    const noCost = JSON.parse(fixture("scorecard.json")) as Record<string, unknown>;
    delete noCost.cost;
    expect(parseScorecard(JSON.stringify(noCost))).toBeNull();
  });
});
