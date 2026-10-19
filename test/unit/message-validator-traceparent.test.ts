/**
 * Message-validator tests: WORK_ORDER/PROMPT envelopes carrying traceparent.
 */
import { describe, expect, it } from "vitest";
import { classifyFrame } from "../../src/bus/message-validator";

const env = (overrides: Record<string, unknown> = {}) => ({
  id: "e1",
  timestamp: 1,
  sender: "s",
  recipient: "a",
  type: "HEARTBEAT",
  payload: { agentId: "a" },
  ...overrides,
});

describe("classifyFrame traceparent", () => {
  it("accepts a WORK_ORDER envelope carrying traceparent", () => {
    const tp = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    const c = classifyFrame(
      JSON.stringify(
        env({
          type: "WORK_ORDER",
          traceparent: tp,
          payload: {
            taskId: "t1",
            action: "review",
            contextFiles: [],
            constraints: [],
            localDoD: "done",
          },
        }),
      ),
    );
    expect(c.kind).toBe("valid");
  });

  it("accepts a PROMPT envelope carrying traceparent", () => {
    const tp = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    const c = classifyFrame(
      JSON.stringify(
        env({
          type: "PROMPT",
          traceparent: tp,
          payload: { agentId: "a", text: "question" },
        }),
      ),
    );
    expect(c.kind).toBe("valid");
  });
});
