/**
 * A2A protocol contract: the event catalogue, the Zod schema for each event
 * payload, and the envelope every bus frame is wrapped in. This is the trust
 * boundary the bus validates against (src/bus/message-validator.ts).
 */
import { z } from "zod";
import { CriterionVerdictSchema } from "./criteria";

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

// AGENT_REGISTERED, STATUS, STATE_CHANGED and BUDGET_THRESHOLD are defined for
// spec completeness but are not yet emitted or routed anywhere in src/ (see
// docs/TODO.md); the runtime dispatcher only switches on the supervisor/peer
// events in use.

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
  RESPONSE: z.strictObject({
    agentId,
    text: z.string(),
    usage: z.strictObject({ cost: z.number(), tokens: z.number() }).optional(),
    // Reviewer attestation: one verdict per DoD criterion, parsed peer-side from
    // a fenced JSON block. This is what the finalize gate trusts, not the
    // supervisor's own claim.
    criteria: z.array(CriterionVerdictSchema).optional(),
  }),
  STATUS: z.strictObject({ agentId, state: z.string(), task: z.string().optional() }),
  STATE_CHANGED: z.strictObject({ agentId, from: z.string(), to: z.string() }),
  INTENT_TO_MODIFY: z.strictObject({ agentId, filePath: z.string(), intent: z.string() }),
  LOCK_REQUEST: lockPayload,
  LOCK_ACQUIRED: lockPayload,
  LOCK_RELEASED: z.strictObject({ agentId, filePath: z.string() }),
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
  FINAL_REPORT: z.strictObject({
    agentId,
    report: z.string(),
    usage: z.strictObject({ cost: z.number(), tokens: z.number() }).optional(),
  }),
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
  // Left unknown here on purpose: the payload is validated against
  // payloadSchemas[type] in a second pass (message-validator.ts) so an invalid
  // payload yields a correlated ERROR reply instead of a dropped frame.
  payload: z.unknown(),
});

export type A2AEnvelope = z.infer<typeof A2AEnvelopeSchema>;
