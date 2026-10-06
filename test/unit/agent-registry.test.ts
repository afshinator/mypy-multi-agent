import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/runtime/agent-registry";

describe("AgentRegistry", () => {
  it("valid registration binds connection to agent", () => {
    const r = new AgentRegistry();
    r.register("conn1", "a1");
    expect(r.has("a1")).toBe(true);
    expect(r.agentOf("conn1")).toBe("a1");
    expect(r.connectionOf("a1")).toBe("conn1");
  });

  it("duplicate agent id rejected", () => {
    const r = new AgentRegistry();
    r.register("conn1", "a1");
    expect(() => r.register("conn2", "a1")).toThrow();
  });

  it("duplicate connection rejected", () => {
    const r = new AgentRegistry();
    r.register("conn1", "a1");
    expect(() => r.register("conn1", "a2")).toThrow();
  });

  it("sender mismatch rejected", () => {
    const r = new AgentRegistry();
    r.register("conn1", "a1");
    expect(r.verifySender("conn1", "a1")).toBe(true);
    expect(r.verifySender("conn1", "other")).toBe(false);
    expect(r.verifySender("unknown", "a1")).toBe(false);
  });
});
