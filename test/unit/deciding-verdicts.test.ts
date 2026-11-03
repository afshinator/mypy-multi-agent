/**
 * One authority for "which verdict block decided the run" (#170). The gate
 * captures at arrival and the scorecard re-derives from the log; both call the
 * same rule, so a card cannot describe a decision the gate did not make.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CriterionVerdict, decidingVerdicts } from "../../src/contracts/criteria";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import { buildScorecard } from "../../src/scorecard/scorecard";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PASS: CriterionVerdict[] = [{ criterion: "dod", result: "pass", evidence: "read a" }];
const FAIL: CriterionVerdict[] = [{ criterion: "dod", result: "fail", evidence: "read b" }];

const config = parseSessionConfig({
  version: "1.1",
  session: {
    id: "s",
    max_cost_usd: 1,
    attester: "peer1",
    agent_stop_threshold_percent: 90,
  },
  ask: { title: "t", description: "d", definition_of_done: ["dod"] },
  agents: [
    {
      id: "peer1",
      title: "p",
      model: "m/m",
      permissions: { read: true, edit: false, shell: false },
      max_cost_usd: 1,
      system_prompt: "s",
    },
  ],
});

const final = {
  outcome: "success",
  exitCode: 0,
  totalCostUsd: 0,
  totalTokens: 0,
  supervisorCostUsd: 0,
  supervisorTokens: 0,
  agentCosts: [],
};

const card = (conversation: unknown[]) =>
  buildScorecard({ conversation, toolCalls: [], final } as never, config);

describe("decidingVerdicts", () => {
  it("keeps the previous block when a later message carries none", () => {
    expect(decidingVerdicts(PASS, [])).toEqual(PASS);
  });

  it("replaces it with a later block", () => {
    expect(decidingVerdicts(PASS, FAIL)).toEqual(FAIL);
  });

  it("is the first block when there was none", () => {
    expect(decidingVerdicts(undefined, PASS)).toEqual(PASS);
    expect(decidingVerdicts(undefined, [])).toBeUndefined();
  });
});

describe("the card and the gate agree", () => {
  it("reads the block the gate would have captured", () => {
    // The scenario the ticket named: a report carrying criteria, then a reply without.
    const conversation = [
      { type: "FINAL_REPORT", sender: "peer1", payload: { report: "done", criteria: PASS } },
      { type: "RESPONSE", sender: "peer1", payload: { text: "noted" } },
    ];
    expect(card(conversation).dod).toBe("met");
  });

  it("takes the later failing block, so a card cannot claim a pass the gate refused", () => {
    const conversation = [
      { type: "RESPONSE", sender: "peer1", payload: { criteria: PASS } },
      { type: "RESPONSE", sender: "peer1", payload: { criteria: FAIL } },
    ];
    expect(card(conversation).dod).toBe("unmet");
  });

  it("ignores a non-attester's block", () => {
    const conversation = [{ type: "RESPONSE", sender: "peer2", payload: { criteria: PASS } }];
    expect(card(conversation).dod).toBe("unknown");
  });

  it("reports dod unknown for a run with no block at all (cards written before this)", () => {
    expect(card([{ type: "FINAL_REPORT", sender: "peer1", payload: { report: "done" } }]).dod).toBe(
      "unknown",
    );
  });
});

describe("one implementation of the rule", () => {
  it("both sides call decidingVerdicts instead of restating it", () => {
    for (const file of ["src/runtime/finalize-gate.ts", "src/scorecard/scorecard.ts"]) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      expect(source).toContain("decidingVerdicts(");
      // The rule is never applied inline: no side assigns a block directly.
      expect(source).not.toContain("this.peerCriteria = criteria;");
      expect(source).not.toContain("latest = criteria as CriterionVerdict[];");
    }
  });
});
