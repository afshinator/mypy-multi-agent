import { z } from "zod";

export const EVENT_TYPES = [
  "AGENT_REGISTER",
  "AGENT_REGISTERED",
  "WORK_ORDER",
  "ACK",
  "PROMPT",
  "RESPONSE",
  "STATUS",
  "STATE_CHANGED",
  "INTENT_TO_MODIFY",
  "LOCK_REQUEST",
  "LOCK_ACQUIRED",
  "LOCK_RELEASED",
  "AGENT_CRASHED",
  "BUDGET_THRESHOLD",
  "STOP_AGENT",
  "STOP_ALL",
  "KILL_ALL",
  "FINAL_REPORT",
  "ERROR",
  "HEARTBEAT",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const permissions = z.strictObject({
  read: z.boolean(),
  edit: z.boolean(),
  shell: z.boolean(),
});

const agentId = z.string().min(1);
const lockPayload = z.strictObject({ agentId, filePath: z.string(), lockId: z.string().min(1) });

export const payloadSchemas = {
  AGENT_REGISTER: z.strictObject({
    agentId,
    title: z.string(),
    model: z.string().min(1),
    permissions,
    maxCostUsd: z.number().gt(0),
    maxTokens: z.number().int().gt(0).optional(),
    systemPrompt: z.string(),
  }),
  AGENT_REGISTERED: z.strictObject({ agentId }),
  WORK_ORDER: z.strictObject({
    taskId: z.string().min(1),
    action: z.string(),
    contextFiles: z.array(z.string()),
    constraints: z.array(z.string()),
    localDoD: z.string(),
  }),
  ACK: z.strictObject({ taskId: z.string().min(1) }),
  PROMPT: z.strictObject({ agentId, text: z.string() }),
  RESPONSE: z.strictObject({ agentId, text: z.string() }),
  STATUS: z.strictObject({ agentId, state: z.string(), task: z.string().optional() }),
  STATE_CHANGED: z.strictObject({ agentId, from: z.string(), to: z.string() }),
  INTENT_TO_MODIFY: z.strictObject({ agentId, filePath: z.string(), intent: z.string() }),
  LOCK_REQUEST: lockPayload,
  LOCK_ACQUIRED: lockPayload,
  LOCK_RELEASED: lockPayload,
  AGENT_CRASHED: z.strictObject({ agentId, reason: z.string().optional() }),
  BUDGET_THRESHOLD: z.strictObject({
    agentId,
    bound: z.enum(["cost", "tokens"]),
    used: z.number(),
    max: z.number(),
    percent: z.number(),
  }),
  STOP_AGENT: z.strictObject({ agentId, reason: z.string().optional() }),
  STOP_ALL: z.strictObject({ reason: z.string().optional() }),
  KILL_ALL: z.strictObject({ reason: z.string().optional() }),
  FINAL_REPORT: z.strictObject({ agentId, report: z.string(), usage: z.strictObject({ cost: z.number(), tokens: z.number() }).optional() }),
  ERROR: z.strictObject({
    code: z.string().min(1),
    message: z.string(),
    correlationId: z.string().optional(),
  }),
  HEARTBEAT: z.strictObject({ agentId }),
} satisfies Record<EventType, z.ZodType>;

export const A2AEnvelopeSchema = z.strictObject({
  id: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  timestamp: z.number(),
  sender: z.string().min(1),
  recipient: z.string().min(1),
  type: z.enum(EVENT_TYPES),
  payload: z.unknown(),
});

export type A2AEnvelope = z.infer<typeof A2AEnvelopeSchema>;
