/**
 * Schema contract tests: traceparent on the A2A envelope (S6/V4, D3).
 */
import { describe, expect, it } from "vitest";
import { A2AEnvelopeSchema } from "../../src/contracts/a2a-schema";

const envelope = (overrides: Record<string, unknown> = {}) => ({
  id: "e1",
  timestamp: 1,
  sender: "supervisor",
  recipient: "a1",
  type: "HEARTBEAT",
  payload: {},
  ...overrides,
});

describe("a2a-schema traceparent", () => {
  it("accepts a traceparent on the envelope (D3 supplements correlationId)", () => {
    const tp = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    expect(A2AEnvelopeSchema.safeParse(envelope({ traceparent: tp })).success).toBe(true);
    expect(
      A2AEnvelopeSchema.safeParse(envelope({ correlationId: "c1", traceparent: tp })).success,
    ).toBe(true);
  });

  it("rejects an empty traceparent", () => {
    expect(A2AEnvelopeSchema.safeParse(envelope({ traceparent: "" })).success).toBe(false);
  });
});
