/**
 * First pass of the bus trust boundary: turns a raw frame into valid / F1 / F2.
 * Owns the JSON parse and envelope check; src/bus/router.ts acts on the result.
 */
import { A2AEnvelopeSchema, payloadSchemas, type A2AEnvelope } from "../contracts/a2a-schema";

export type FrameClassification =
  | { kind: "valid"; envelope: A2AEnvelope }
  | { kind: "f1"; reason: "invalid-json" | "invalid-envelope" }
  | { kind: "f2"; envelope: A2AEnvelope };

/**
 * Classify a raw frame.
 * F1 = unparseable JSON or invalid envelope (untrustworthy: drop, no reply).
 * F2 = valid envelope but payload fails its event schema (reply with ERROR).
 */
export function classifyFrame(line: string): FrameClassification {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "f1", reason: "invalid-json" };
  }
  const env = A2AEnvelopeSchema.safeParse(raw);
  if (!env.success) return { kind: "f1", reason: "invalid-envelope" };
  const payload = payloadSchemas[env.data.type].safeParse(env.data.payload);
  if (!payload.success) return { kind: "f2", envelope: env.data };
  return { kind: "valid", envelope: env.data };
}
