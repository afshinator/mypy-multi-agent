/**
 * Unit tests for the pure scorecard module (issue #14).
 * External behaviour only: feed fixture artifacts, assert the derived fields.
 */
import { describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import {
  buildScorecard,
  normalizeOutcome,
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
const fail = (criterion: string) => ({ criterion, result: "fail" as const, evidence: "e" });

/** An attestation round: the attester replies with criteria and no report body. */
const round = (criteria: unknown[]) => ({
  type: "RESPONSE",
  sender: "a1",
  recipient: "supervisor",
  timestamp: 2000,
  payload: { agentId: "a1", text: "verdicts", criteria },
});

/** The attester's disposition report, which also carries criteria but is not a round. */
const disposition = (criteria: unknown[]) => ({
  type: "FINAL_REPORT",
  sender: "a1",
  recipient: "supervisor",
  timestamp: 2000,
  payload: { agentId: "a1", report: "dispositions", criteria },
});

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
        taskId: "t1",
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

describe("attestation re-work and task identity", () => {
  it("counts the attester's rounds and whether the first one failed", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      round([pass("dod1"), fail("dod2"), fail("dod1")]),
      round([pass("dod1"), fail("dod2")]),
      round([pass("dod1"), pass("dod2")]),
    ];
    const sc = buildScorecard(artifacts, config);
    expect(sc.attestationRounds).toBe(3);
    expect(sc.firstAttestationRoundFailed).toBe(true);
  });

  it("does not count the disposition report as a round", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [disposition([pass("dod1"), pass("dod2")]), round([fail("dod1")])];
    const sc = buildScorecard(artifacts, config);
    expect(sc.attestationRounds).toBe(1);
    // The disposition is excluded, so the only round is the failing one.
    expect(sc.firstAttestationRoundFailed).toBe(true);
  });

  it("a first-round pass is not re-work", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [round([pass("dod1"), pass("dod2")])];
    const sc = buildScorecard(artifacts, config);
    expect(sc.attestationRounds).toBe(1);
    expect(sc.firstAttestationRoundFailed).toBe(false);
  });

  it("reports zero rounds when the attester never replied with a verdict block", () => {
    const sc = buildScorecard(cleanArtifacts(), config);
    expect(sc.attestationRounds).toBe(0);
    expect(sc.firstAttestationRoundFailed).toBe(false);
  });

  it("carries the run's task directory when the seam supplies it", () => {
    const withTask = cleanArtifacts();
    withTask.task = "mypi-tasks/post-mortem-03";
    expect(buildScorecard(withTask, config).task).toBe("mypi-tasks/post-mortem-03");
    expect(buildScorecard(cleanArtifacts(), config).task).toBeUndefined();
  });
});

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
      "task",
      "attestationRounds",
      "firstAttestationRoundFailed",
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
      "mistakes",
    ]);
    for (const key of Object.keys(sc)) {
      expect(allowedTopLevel.has(key as keyof RunScorecard), `unexpected key ${key}`).toBe(true);
    }
  });

  it("interleaved prompt turns pair by correlationId, not timestamp position (#21)", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      {
        type: "PROMPT",
        sender: "a2",
        recipient: "a1",
        correlationId: "c1",
        timestamp: 0,
        payload: { agentId: "a1", text: "first" },
      },
      {
        type: "PROMPT",
        sender: "a2",
        recipient: "a1",
        correlationId: "c2",
        timestamp: 100,
        payload: { agentId: "a1", text: "second" },
      },
      // Second turn closes first: timestamp-zip would swap the two durations.
      {
        type: "RESPONSE",
        sender: "a1",
        recipient: "a2",
        correlationId: "c2",
        timestamp: 300,
        payload: { agentId: "a1", text: "done 2" },
      },
      {
        type: "RESPONSE",
        sender: "a1",
        recipient: "a2",
        correlationId: "c1",
        timestamp: 500,
        payload: { agentId: "a1", text: "done 1" },
      },
    ];
    const sc = buildScorecard(artifacts, config);
    expect(sc.turnDurationsMs).toEqual({ a1: [500, 200] });
  });

  it("mixed work-order and prompt turns completing out of order pair by taskId and correlationId (#21)", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      {
        type: "WORK_ORDER",
        sender: "supervisor",
        recipient: "a1",
        timestamp: 0,
        payload: { taskId: "t1", action: "do" },
      },
      {
        type: "PROMPT",
        sender: "a2",
        recipient: "a1",
        correlationId: "p1",
        timestamp: 100,
        payload: { agentId: "a1", text: "peer asks" },
      },
      {
        type: "RESPONSE",
        sender: "a1",
        recipient: "a2",
        correlationId: "p1",
        timestamp: 300,
        payload: { agentId: "a1", text: "answer" },
      },
      {
        type: "FINAL_REPORT",
        sender: "a1",
        recipient: "supervisor",
        taskId: "t1",
        timestamp: 500,
        payload: { agentId: "a1", report: "done" },
      },
    ];
    const sc = buildScorecard(artifacts, config);
    expect(sc.turnDurationsMs).toEqual({ a1: [500, 200] });
  });
});

// StrykerJS survivors (issue #141 follow-up). Each case below covers a behaviour
// that no test observed, so a mutation of it changed the card silently: the
// stop-reason taxonomy, the outcome vocabulary, the attester-only filters, the
// error and timeout counters, and the null boundaries of the mismatch check.
const stop = (reason: unknown, timestamp = 1000): Record<string, unknown> => ({
  type: "STOP_AGENT",
  sender: "supervisor",
  recipient: "a1",
  timestamp,
  payload: { reason },
});

const event = (type: string, timestamp: number, extra: Record<string, unknown> = {}) => ({
  type,
  sender: "a1",
  recipient: "supervisor",
  timestamp,
  payload: {},
  ...extra,
});

/** A card for one final.md outcome plus one attester verdict block. */
function cardFor(outcome: string | null, exitCode: number | null, verdicts: unknown[] | undefined) {
  const artifacts = cleanArtifacts();
  artifacts.final = { ...artifacts.final, outcome, exitCode };
  artifacts.conversation =
    verdicts === undefined
      ? []
      : [
          {
            type: "FINAL_REPORT",
            sender: "a1",
            recipient: "supervisor",
            taskId: "t1",
            timestamp: 6000,
            payload: { agentId: "a1", report: "done", criteria: verdicts },
          },
        ];
  return buildScorecard(artifacts, config);
}

describe("stop-agent reason taxonomy", () => {
  it("counts every documented reason and folds anything else into other", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      ...[
        "user",
        "supervisor",
        "budget threshold",
        "heartbeat timeout",
        "protocol fault",
        "empty model output",
      ].map((reason, i) => stop(reason, 1000 + i)),
      stop("made-up"),
      stop(42),
    ];
    expect(buildScorecard(artifacts, config).stopAgentReasons).toEqual({
      user: 1,
      supervisor: 1,
      "budget threshold": 1,
      "heartbeat timeout": 1,
      "protocol fault": 1,
      "empty model output": 1,
      other: 2,
    });
  });
});

describe("normalizeOutcome", () => {
  it("keeps the three known outcomes, folds the rest into unknown, and preserves null", () => {
    expect(normalizeOutcome("success")).toBe("success");
    expect(normalizeOutcome("failure")).toBe("failure");
    expect(normalizeOutcome("aborted")).toBe("aborted");
    expect(normalizeOutcome("timed-out")).toBe("unknown");
    expect(normalizeOutcome(null)).toBeNull();
  });
});

describe("attester-only evidence", () => {
  it("ignores a verdict block from a peer that is not the attester", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      {
        type: "RESPONSE",
        sender: "a2",
        recipient: "supervisor",
        timestamp: 1000,
        payload: { agentId: "a2", criteria: [pass("dod1"), pass("dod2")] },
      },
    ];
    expect(buildScorecard(artifacts, config).dod).toBe("unknown");
  });

  it("accepts an attestation carried by a RESPONSE", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      {
        type: "RESPONSE",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 6000,
        payload: { criteria: [pass("dod1"), pass("dod2")] },
      },
    ];
    expect(buildScorecard(artifacts, config).dod).toBe("met");
  });

  it("ignores a verdict-shaped block on an event that is not a reply", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      {
        type: "RETRY",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 1,
        payload: { criteria: [pass("dod1"), pass("dod2")] },
      },
    ];
    const card = buildScorecard(artifacts, config);
    expect(card.dod).toBe("unknown");
    expect(card.attestationRounds).toBe(0);
  });

  it("treats an empty verdict block as no attestation, not as a failed one", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      {
        type: "RESPONSE",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 1,
        payload: { criteria: [] },
      },
    ];
    const card = buildScorecard(artifacts, config);
    expect(card.dod).toBe("unknown");
    expect(card.attestationRounds).toBe(0);
  });

  it("accepts an attestation that arrives only in a FINAL_REPORT", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      {
        type: "FINAL_REPORT",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 6000,
        payload: { criteria: [pass("dod1"), pass("dod2")] },
      },
    ];
    expect(buildScorecard(artifacts, config).dod).toBe("met");
  });

  it("counts rework rounds from the attester only, including a FINAL_REPORT round", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      round([fail("dod1")]),
      round([pass("dod1"), pass("dod2")]),
      {
        type: "RESPONSE",
        sender: "a2",
        recipient: "supervisor",
        timestamp: 3000,
        payload: { agentId: "a2", criteria: [pass("dod1")] },
      },
      {
        type: "FINAL_REPORT",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 4000,
        payload: { criteria: [pass("dod1"), pass("dod2")] },
      },
    ];
    const card = buildScorecard(artifacts, config);
    expect(card.attestationRounds).toBe(3);
    expect(card.firstAttestationRoundFailed).toBe(true);
  });

  it("ignores malformed conversation entries instead of throwing", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      { type: "RESPONSE", sender: "a1", recipient: "supervisor", timestamp: 1, payload: null },
      { type: "FINAL_REPORT", sender: "a1", recipient: "supervisor", timestamp: 2 },
      {
        type: "RESPONSE",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 3,
        payload: { criteria: "not-an-array" },
      },
    ];
    expect(buildScorecard(artifacts, config).dod).toBe("unknown");
  });
});

describe("tool-call accounting", () => {
  it("counts an errored tool call", () => {
    const artifacts = cleanArtifacts();
    artifacts.toolCalls = [
      { agentId: "a1", toolName: "read", durationMs: 100, isError: true },
      { agentId: "a1", toolName: "write", durationMs: 200, isError: false },
    ];
    const card = buildScorecard(artifacts, config);
    expect(card.toolErrors).toBe(1);
    expect(card.toolCalls).toBe(2);
  });

  it("sums only finite, non-negative durations, so a bad one cannot poison the total", () => {
    const artifacts = cleanArtifacts();
    artifacts.toolCalls = [
      { agentId: "a1", toolName: "read", durationMs: 100, isError: false },
      { agentId: "a1", toolName: "read", isError: false },
      { agentId: "a1", toolName: "read", durationMs: null, isError: false },
      { agentId: "a1", toolName: "read", durationMs: -5, isError: false },
      { agentId: "a1", toolName: "read", durationMs: 0, isError: false },
      { agentId: "a1", toolName: "read", durationMs: Number.POSITIVE_INFINITY, isError: false },
    ];
    const card = buildScorecard(artifacts, config);
    expect(card.toolTimeMs).toBe(100);
    expect(Number.isNaN(card.toolTimeMs)).toBe(false);
    expect(card.toolCalls).toBe(6);
  });

  it("attributes time only to agents the run configured", () => {
    const artifacts = cleanArtifacts();
    artifacts.toolCalls = [
      { toolName: "read", durationMs: 50, isError: false },
      { agentId: "a9", toolName: "read", durationMs: 60, isError: false },
      { agentId: "a1", toolName: "read", durationMs: 70, isError: false },
    ];
    const card = buildScorecard(artifacts, config);
    expect(card.toolTimeMs).toBe(180);
    expect(card.toolTimeByAgentMs).toEqual({ a1: 70 });
  });
});

describe("timeout and outcome-exit accounting", () => {
  it("counts a correlation timeout, and only that combination", () => {
    const artifacts = cleanArtifacts();
    artifacts.conversation = [
      event("ERROR", 1, { event: "correlation-timeout" }),
      event("ERROR", 2, { event: "peer-crashed" }),
      event("ACK", 3, { event: "correlation-timeout" }),
    ];
    expect(buildScorecard(artifacts, config).correlationTimeouts).toBe(1);
  });

  it("reports an outcome/exit mismatch only when both are known and disagree", () => {
    expect(cardFor("success", 0, [pass("dod1"), pass("dod2")]).outcomeExitMismatch).toBe(false);
    expect(cardFor("success", 1, [pass("dod1"), pass("dod2")]).outcomeExitMismatch).toBe(true);
    expect(cardFor("failure", 0, [pass("dod1"), pass("dod2")]).outcomeExitMismatch).toBe(true);
    expect(cardFor(null, 0, [pass("dod1"), pass("dod2")]).outcomeExitMismatch).toBe(false);
    expect(cardFor("success", null, [pass("dod1"), pass("dod2")]).outcomeExitMismatch).toBe(false);
  });

  it("calls a green exit with an unmet DoD a false success", () => {
    expect(cardFor("success", 0, [fail("dod1"), pass("dod2")]).falseSuccess).toBe(true);
    expect(cardFor("success", 0, [pass("dod1"), pass("dod2")]).falseSuccess).toBe(false);
    expect(cardFor("success", 0, undefined).falseSuccess).toBe(false);
    expect(cardFor("failure", 1, [fail("dod1"), pass("dod2")]).falseSuccess).toBe(false);
  });

  it("records the task directory when the caller supplies it, and omits it otherwise", () => {
    const artifacts = cleanArtifacts();
    artifacts.task = "mypi-tasks/00-example";
    expect(buildScorecard(artifacts, config).task).toBe("mypi-tasks/00-example");
    const without = cleanArtifacts();
    expect(buildScorecard(without, config).task).toBeUndefined();
  });
});
