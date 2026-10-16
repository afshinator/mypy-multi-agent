/**
 * Unit tests for the pure scorecard module (issue #14).
 * External behaviour only: feed fixture artifacts, assert the derived fields.
 */
import { describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import {
  buildScorecard,
  type RunScorecard,
  type ScorecardArtifacts,
  TAXONOMY_VERSION,
} from "../../src/scorecard/scorecard";

const config = parseSessionConfig({
  version: "1.1",
  session: { id: "s1", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "a1" },
  ask: { title: "t", description: "d", definition_of_done: ["dod1", "dod2"] },
  agents: [
    {
      id: "a1",
      title: "A",
      model: "m/a",
      permissions: { read: true, edit: false, shell: false },
      max_cost_usd: 1,
      system_prompt: "sp",
    },
    {
      id: "a2",
      title: "B",
      model: "m/b",
      permissions: { read: true, edit: false, shell: false },
      max_cost_usd: 1,
      system_prompt: "sp",
    },
  ],
});

const pass = (criterion: string) => ({ criterion, result: "pass" as const, evidence: "e" });

function cleanArtifacts(): ScorecardArtifacts {
  return {
    final: {
      outcome: "success",
      exitCode: 0,
      totalCostUsd: 1.5,
      totalTokens: 300,
      supervisorCostUsd: 0.5,
      supervisorTokens: 100,
      agentCosts: [{ name: "a1", costUsd: 1.0, tokens: 200 }],
    },
    conversation: [
      {
        type: "WORK_ORDER",
        sender: "supervisor",
        recipient: "a1",
        timestamp: 1000,
        payload: { taskId: "t1", action: "do thing" },
      },
      {
        type: "FINAL_REPORT",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 6000,
        payload: {
          agentId: "a1",
          report: "done",
          criteria: [pass("dod1"), pass("dod2")],
        },
      },
    ],
    toolCalls: [
      { agentId: "a1", toolName: "read", durationMs: 100, isError: false },
      { agentId: "a1", toolName: "write", durationMs: 200, isError: false },
    ],
  };
}

describe("buildScorecard", () => {
  it("clean run: success, DoD met, turn/tool time derived, costs and roster carried", () => {
    const sc = buildScorecard(cleanArtifacts(), config);
    expect(sc.outcome).toBe("success");
    expect(sc.exitCode).toBe(0);
    expect(sc.outcomeExitMismatch).toBe(false);
    expect(sc.dod).toBe("met");
    expect(sc.falseSuccess).toBe(false);
    expect(sc.turnDurationsMs).toEqual({ a1: [5000] });
    expect(sc.toolTimeMs).toBe(300);
    expect(sc.toolTimeByAgentMs).toEqual({ a1: 300 });
    expect(sc.toolCalls).toBe(2);
    expect(sc.toolErrors).toBe(0);
    expect(sc.retries).toBe(0);
    expect(sc.correlationTimeouts).toBe(0);
    expect(sc.agentCrashed).toBe(0);
    expect(sc.agentUnusable).toBe(0);
    expect(sc.agentStalled).toBe(0);
    expect(sc.stopAgentReasons).toEqual({});
    expect(sc.cost).toEqual({
      totalCostUsd: 1.5,
      totalTokens: 300,
      supervisorCostUsd: 0.5,
      supervisorTokens: 100,
      agents: [{ agentId: "a1", costUsd: 1.0, tokens: 200 }],
    });
    expect(sc.modelRoster).toEqual(["m/a", "m/b"]);
  });

  it("timeout-heavy run: counts crashes, stalls, unusable, retries, timeouts and stop reasons", () => {
    const artifacts = cleanArtifacts();
    artifacts.final = { ...artifacts.final, outcome: "failure", exitCode: 1 };
    artifacts.conversation = [
      { type: "ERROR", event: "correlation-timeout", timestamp: 1, to: "a1", timeoutMs: 100 },
      { type: "ERROR", event: "correlation-timeout", timestamp: 2, agentId: "a1", timeoutMs: 100 },
      { type: "RETRY", timestamp: 3, agentId: "a1", attempt: 1, maxAttempts: 3 },
      { type: "RETRY", timestamp: 4, agentId: "a1", attempt: 2, maxAttempts: 3 },
      { type: "RETRY", timestamp: 5, agentId: "a1", attempt: 3, maxAttempts: 3 },
      {
        type: "AGENT_STALLED",
        timestamp: 6,
        payload: { agentId: "a1", reason: "no progress", elapsedMs: 300000 },
      },
      {
        type: "AGENT_STALLED",
        timestamp: 7,
        payload: { agentId: "a1", reason: "no progress", elapsedMs: 300001 },
      },
      { type: "AGENT_CRASHED", timestamp: 8, payload: { agentId: "a1", reason: "disconnected" } },
      {
        type: "AGENT_UNUSABLE",
        timestamp: 9,
        payload: { agentId: "a1", reason: "empty turns", attempts: 4 },
      },
      { type: "STOP_AGENT", timestamp: 10, payload: { agentId: "a1", reason: "budget threshold" } },
      { type: "STOP_AGENT", timestamp: 11, payload: { agentId: "a2", reason: "budget threshold" } },
      { type: "STOP_AGENT", timestamp: 12, payload: { agentId: "a1", reason: "protocol fault" } },
      {
        type: "FINAL_REPORT",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 13,
        payload: { agentId: "a1", report: "done", criteria: [pass("dod1"), pass("dod2")] },
      },
    ];
    const sc = buildScorecard(artifacts, config);
    expect(sc.outcome).toBe("failure");
    expect(sc.exitCode).toBe(1);
    expect(sc.outcomeExitMismatch).toBe(false);
    expect(sc.dod).toBe("met");
    expect(sc.correlationTimeouts).toBe(2);
    expect(sc.retries).toBe(3);
    expect(sc.agentStalled).toBe(2);
    expect(sc.agentCrashed).toBe(1);
    expect(sc.agentUnusable).toBe(1);
    expect(sc.stopAgentReasons).toEqual({ "budget threshold": 2, "protocol fault": 1 });
  });

  it("false-success run: exit 0 with DoD unmet is visible", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      {
        type: "FINAL_REPORT",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 1,
        payload: {
          agentId: "a1",
          report: "done",
          criteria: [{ criterion: "dod1", result: "fail" as const, evidence: "e" }, pass("dod2")],
        },
      },
    ];
    const sc = buildScorecard(artifacts, config);
    expect(sc.outcome).toBe("success");
    expect(sc.exitCode).toBe(0);
    expect(sc.outcomeExitMismatch).toBe(false);
    expect(sc.dod).toBe("unmet");
    expect(sc.falseSuccess).toBe(true);
  });

  it("outcome/exit mismatch is derived independently", () => {
    const artifacts = cleanArtifacts();
    artifacts.final = { ...artifacts.final, outcome: "failure", exitCode: 0 };
    const sc = buildScorecard(artifacts, config);
    expect(sc.outcome).toBe("failure");
    expect(sc.exitCode).toBe(0);
    expect(sc.outcomeExitMismatch).toBe(true);
  });

  it("no attester verdict block means DoD unknown", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [];
    const sc = buildScorecard(artifacts, config);
    expect(sc.dod).toBe("unknown");
    expect(sc.falseSuccess).toBe(false);
  });

  it("stamps the taxonomy version", () => {
    expect(TAXONOMY_VERSION).toBeTruthy();
    expect(buildScorecard(cleanArtifacts(), config).taxonomyVersion).toBe(TAXONOMY_VERSION);
  });

  it("is pure: same input twice gives deep-equal output and inputs are not mutated", () => {
    const artifacts = cleanArtifacts();
    const before = structuredClone(artifacts);
    const a = buildScorecard(artifacts, config);
    const b = buildScorecard(artifacts, config);
    expect(b).toEqual(a);
    expect(artifacts).toEqual(before);
  });

  it("boundary: no free-text sentinel can reach the scorecard, and only allowed keys exist", () => {
    const S_PROMPT = "SENTINEL_PROMPT_7f3a9c";
    const S_REPORT = "SENTINEL_REPORT_9c2b1d";
    const S_SYSTEM = "SENTINEL_SYSTEM_1d4e5f";
    const S_TOOLARGS = "SENTINEL_TOOLARGS_5a6f7b";
    const S_EVIDENCE = "SENTINEL_EVIDENCE_8b7c6d";
    const S_STOPREASON = "SENTINEL_STOPREASON_2c4d6e";
    const S_STATUS = "SENTINEL_STATUS_1b3a5c";
    const S_AGENT = "SENTINEL_AGENT_4e8f1a";

    const artifacts: ScorecardArtifacts = {
      final: {
        outcome: S_STATUS,
        exitCode: 0,
        totalCostUsd: null,
        totalTokens: null,
        supervisorCostUsd: null,
        supervisorTokens: null,
        agentCosts: [{ name: S_AGENT, costUsd: 1, tokens: 1 }],
      },
      conversation: [
        {
          type: "AGENT_REGISTER",
          sender: "a1",
          recipient: "supervisor",
          timestamp: 1,
          payload: { agentId: "a1", systemPrompt: S_SYSTEM },
        },
        {
          type: "PROMPT",
          sender: "a2",
          recipient: "a1",
          timestamp: 2,
          payload: { agentId: "a1", text: S_PROMPT },
        },
        {
          type: "WORK_ORDER",
          sender: "supervisor",
          recipient: "a1",
          timestamp: 3,
          payload: { taskId: "t1", action: S_PROMPT },
        },
        {
          type: "WORK_ORDER",
          sender: "supervisor",
          recipient: S_AGENT,
          timestamp: 3.5,
          payload: { taskId: "t2", action: S_PROMPT },
        },
        {
          type: "FINAL_REPORT",
          sender: S_AGENT,
          recipient: "supervisor",
          timestamp: 4.5,
          payload: { agentId: S_AGENT, report: S_REPORT },
        },
        {
          type: "FINAL_REPORT",
          sender: "a1",
          recipient: "supervisor",
          timestamp: 4,
          payload: { agentId: "a1", report: S_REPORT, criteria: [pass("dod1"), pass("dod2")] },
        },
        {
          type: "RESPONSE",
          sender: "a1",
          recipient: "a2",
          timestamp: 5,
          payload: {
            agentId: "a1",
            text: S_PROMPT,
            criteria: [{ criterion: "dod1", result: "pass", evidence: S_EVIDENCE }, pass("dod2")],
          },
        },
        {
          type: "STOP_AGENT",
          sender: "bus",
          recipient: "a1",
          timestamp: 6,
          payload: { agentId: "a1", reason: "budget threshold" },
        },
        {
          type: "STOP_AGENT",
          sender: "bus",
          recipient: "a2",
          timestamp: 7,
          payload: { agentId: "a2", reason: S_STOPREASON },
        },
      ],
      toolCalls: [
        {
          agentId: "a1",
          toolName: "write",
          toolCallId: "c1",
          args: { content: S_TOOLARGS },
          isError: false,
          durationMs: 10,
        },
        {
          agentId: S_AGENT,
          toolName: "write",
          toolCallId: "c2",
          args: {},
          isError: false,
          durationMs: 10,
        },
      ],
    };

    const sc = buildScorecard(artifacts, config);
    const json = JSON.stringify(sc);
    expect(json).not.toContain(S_PROMPT);
    expect(json).not.toContain(S_REPORT);
    expect(json).not.toContain(S_SYSTEM);
    expect(json).not.toContain(S_TOOLARGS);
    expect(json).not.toContain(S_EVIDENCE);
    expect(json).not.toContain(S_STOPREASON);
    expect(json).not.toContain(S_STATUS);
    expect(json).not.toContain(S_AGENT);
    expect(sc.outcome).toBe("unknown");
    expect(sc.stopAgentReasons).toEqual({ "budget threshold": 1, other: 1 });
    expect(sc.stopAgentReasons[S_STOPREASON]).toBeUndefined();

    const allowedTopLevel = new Set<keyof RunScorecard>([
      "taxonomyVersion",
      "outcome",
      "exitCode",
      "outcomeExitMismatch",
      "dod",
      "falseSuccess",
      "turnDurationsMs",
      "toolTimeMs",
      "toolTimeByAgentMs",
      "toolCalls",
      "toolErrors",
      "retries",
      "correlationTimeouts",
      "agentCrashed",
      "agentUnusable",
      "agentStalled",
      "stopAgentReasons",
      "cost",
      "modelRoster",
    ]);
    for (const key of Object.keys(sc)) {
      expect(allowedTopLevel.has(key as keyof RunScorecard), `unexpected key ${key}`).toBe(true);
    }
  });
});
