/**
 * The bus trust boundary: classifies a raw frame as valid / f1 / f2 (JSON
 * parse, envelope check, then payload-schema check). src/bus/router.ts applies
 * the F1/F2 policy.
 */
import { type A2AEnvelope, A2AEnvelopeSchema, payloadSchemas } from "../contracts/a2a-schema";

export type FrameClassification =
  | { kind: "valid"; envelope: A2AEnvelope }
  | { kind: "f1"; reason: "invalid-json" | "invalid-envelope" }
  | { kind: "f2"; envelope: A2AEnvelope };

/**
 * F1 = unparseable JSON or invalid envelope. F2 = valid envelope whose payload
 * fails its event schema.
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
