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

describe("classifyFrame", () => {
  it("valid frame", () => {
    expect(classifyFrame(JSON.stringify(env())).kind).toBe("valid");
  });

  it("f1: invalid JSON", () => {
    const c = classifyFrame("{not json");
    expect(c.kind).toBe("f1");
    if (c.kind === "f1") expect(c.reason).toBe("invalid-json");
  });

  it("f1: invalid envelope", () => {
    const c = classifyFrame(JSON.stringify({ ...env(), id: undefined }));
    expect(c.kind).toBe("f1");
  });

  it("f2: valid envelope, invalid payload", () => {
    const c = classifyFrame(JSON.stringify(env({ payload: { nope: true } })));
    expect(c.kind).toBe("f2");
    if (c.kind === "f2") expect(c.envelope.correlationId).toBeUndefined();
  });
});
