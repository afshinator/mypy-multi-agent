import { describe, expect, it } from "vitest";
import { parseSessionConfig, type SessionConfig } from "../../src/contracts/session-schema";
import { classifyMistakes, type MistakeInputs } from "../../src/scorecard/mistakes";

const priced = () => false;

function config(): SessionConfig {
  return parseSessionConfig(
    {
      version: "1.2",
      session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "rev" },
      ask: { title: "t", description: "d", definition_of_done: ["a", "b", "c"] },
      agents: [
        {
          id: "rev",
          title: "R",
          model: "p/m",
          permissions: { read: true, edit: false, shell: false },
          max_cost_usd: 1,
          system_prompt: "sp",
        },
      ],
    },
    priced,
  );
}

const base: MistakeInputs = {
  outcome: "success",
  exitCode: 0,
  outcomeExitMismatch: false,
  dod: "met",
  falseSuccess: false,
  turnDurationsMs: {},
  agentStalled: 0,
  correlationTimeouts: 0,
};

const classes = (over: Partial<MistakeInputs>): string[] =>
  classifyMistakes({ ...base, ...over }, config()).map((m) => m.class);

describe("classifyMistakes", () => {
  it("a clean run has no mistakes", () => {
    expect(classifyMistakes(base, config())).toEqual([]);
  });

  it("M1 on a recorded stall", () => {
    expect(classes({ agentStalled: 1 })).toEqual(["M1"]);
  });

  it("M1 on a correlation timeout against a working peer", () => {
    expect(classes({ correlationTimeouts: 2 })).toEqual(["M1"]);
  });

  it("M1 on a turn at or over the stall threshold", () => {
    expect(classes({ turnDurationsMs: { a: [300000] } })).toEqual(["M1"]);
  });

  it("no M1 for a turn under the threshold", () => {
    expect(classes({ turnDurationsMs: { a: [1000, 299999] } })).toEqual([]);
  });

  it("M2 on an outcome/exit mismatch", () => {
    expect(classes({ outcome: "success", exitCode: 1, outcomeExitMismatch: true })).toEqual(["M2"]);
  });

  it("M3 on exit 0 with the DoD unmet (false success)", () => {
    expect(classes({ dod: "unmet", falseSuccess: true })).toEqual(["M3"]);
  });

  it("M3 on success with no attester verdict", () => {
    expect(classes({ dod: "unknown" })).toEqual(["M3"]);
  });

  it("M3 does not fire for an unknown DoD on a non-success run", () => {
    expect(classes({ outcome: "failure", exitCode: 1, dod: "unknown" })).toEqual([]);
  });

  it("details carry numbers/enums only, never free text", () => {
    const [m] = classifyMistakes(
      { ...base, agentStalled: 1, turnDurationsMs: { a: [300000] } },
      config(),
    );
    expect(m?.detail).toMatch(/^stalled=\d+ correlationTimeouts=\d+ slowTurns=\d+ \(>=\d+ms\)$/);
  });
});
