import { describe, expect, it } from "vitest";
import {
  A2AEnvelopeSchema,
  EVENT_TYPES,
  payloadSchemas,
} from "../../src/contracts/a2a-schema";

const validPayloads: Record<string, unknown> = {
  AGENT_REGISTER: {
    agentId: "a1",
    title: "A",
    model: "provider/model",
    permissions: { read: true, edit: false, shell: false },
    maxCostUsd: 1,
    systemPrompt: "sp",
  },
  AGENT_REGISTERED: { agentId: "a1" },
  WORK_ORDER: {
    taskId: "w1",
    action: "review",
    contextFiles: ["src/a.ts"],
    constraints: [],
    localDoD: "done when reviewed",
  },
  ACK: { taskId: "w1" },
  PROMPT: { agentId: "a2", text: "what do you think?" },
  RESPONSE: { agentId: "a1", text: "here" },
  STATUS: { agentId: "a1", state: "WORKING", task: "t" },
  STATE_CHANGED: { agentId: "a1", from: "PENDING", to: "WORKING" },
  INTENT_TO_MODIFY: { agentId: "a1", filePath: "src/a.ts", intent: "fix" },
  LOCK_REQUEST: { agentId: "a1", filePath: "src/a.ts", lockId: "l1" },
  LOCK_ACQUIRED: { agentId: "a1", filePath: "src/a.ts", lockId: "l1" },
  LOCK_RELEASED: { agentId: "a1", filePath: "src/a.ts", lockId: "l1" },
  AGENT_CRASHED: { agentId: "a1" },
  BUDGET_THRESHOLD: { agentId: "a1", bound: "tokens", used: 900, max: 1000, percent: 90 },
  STOP_AGENT: { agentId: "a1" },
  STOP_ALL: {},
  KILL_ALL: {},
  FINAL_REPORT: { agentId: "a1", report: "done" },
  ERROR: { code: "E1", message: "bad" },
  HEARTBEAT: { agentId: "a1" },
};

const invalidPayloads: Record<string, unknown> = {
  AGENT_REGISTER: { agentId: "a1" }, // missing required fields
  AGENT_REGISTERED: { nope: true },
  WORK_ORDER: { taskId: 123, action: "x" },
  ACK: { taskId: 123 },
  PROMPT: { agentId: "a2" }, // missing text
  RESPONSE: { text: "here" }, // missing agentId
  STATUS: { agentId: "a1", state: 123 },
  STATE_CHANGED: { agentId: "a1", from: "PENDING" }, // missing to
  INTENT_TO_MODIFY: { agentId: "a1", filePath: "src/a.ts" }, // missing intent
  LOCK_REQUEST: { agentId: "a1", filePath: "src/a.ts" }, // missing lockId
  LOCK_ACQUIRED: { agentId: "a1" }, // missing filePath/lockId
  LOCK_RELEASED: { lockId: "l1" }, // missing agentId/filePath
  AGENT_CRASHED: { agentId: 123 },
  BUDGET_THRESHOLD: { agentId: "a1", bound: "cost", used: 1, max: 2 }, // missing percent
  STOP_AGENT: { reason: 123 }, // missing agentId
  STOP_ALL: { reason: 123 }, // wrong type
  KILL_ALL: { reason: 123 },
  FINAL_REPORT: { agentId: "a1" }, // missing report
  ERROR: { code: "E1" }, // missing message
  HEARTBEAT: { agentId: 123 },
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    timestamp: 1,
    sender: "supervisor",
    recipient: "a1",
    type: "HEARTBEAT",
    payload: {},
    ...overrides,
  };
}

describe("a2a-schema", () => {
  it("event enum is complete and non-empty", () => {
    expect(EVENT_TYPES).toHaveLength(20);
  });

  it("every event has a concrete payload schema", () => {
    for (const type of EVENT_TYPES) {
      expect(payloadSchemas[type], `missing payload schema for ${type}`).toBeDefined();
    }
  });

  for (const type of EVENT_TYPES) {
    it(`${type}: valid payload accepted`, () => {
      const result = payloadSchemas[type]!.safeParse(validPayloads[type]);
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
    });

    it(`${type}: invalid payload rejected`, () => {
      const result = payloadSchemas[type]!.safeParse(invalidPayloads[type]);
      expect(result.success).toBe(false);
    });
  }

  it("missing envelope field rejected", () => {
    const e = envelope();
    delete (e as Record<string, unknown>).id;
    expect(A2AEnvelopeSchema.safeParse(e).success).toBe(false);
  });

  it("unknown event type rejected", () => {
    expect(A2AEnvelopeSchema.safeParse(envelope({ type: "NOPE" })).success).toBe(false);
  });

  it("invalid recipient rejected", () => {
    expect(A2AEnvelopeSchema.safeParse(envelope({ recipient: 123 })).success).toBe(false);
  });

  it("malformed sender rejected", () => {
    expect(A2AEnvelopeSchema.safeParse(envelope({ sender: "" })).success).toBe(false);
  });

  it("FINAL_REPORT rejects invalid usage", () => {
    expect(payloadSchemas.FINAL_REPORT.safeParse({ agentId: "a", report: "r", usage: { cost: "x", tokens: 1 } }).success).toBe(false);
    expect(payloadSchemas.FINAL_REPORT.safeParse({ agentId: "a", report: "r", usage: { cost: 0.5, tokens: 100 } }).success).toBe(true);
  });

  it("optional correlationId", () => {
    expect(A2AEnvelopeSchema.safeParse(envelope()).success).toBe(true);
    expect(A2AEnvelopeSchema.safeParse(envelope({ correlationId: "c1" })).success).toBe(true);
  });
});
