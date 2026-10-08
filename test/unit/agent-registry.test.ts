/**
 * Unit tests for the agent registry module.
 */
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

  it("remove drops the binding so the agent can re-register", () => {
    const r = new AgentRegistry();
    r.register("conn1", "a1");
    r.remove("conn1");
    expect(r.agentOf("conn1")).toBeUndefined();
    expect(r.has("a1")).toBe(false);
    r.register("conn2", "a1"); // re-register succeeds
    expect(r.connectionOf("a1")).toBe("conn2");
  });

  it("remove of an unknown connection is a no-op", () => {
    const r = new AgentRegistry();
    r.register("conn1", "a1");
    r.remove("conn9");
    expect(r.connectionOf("a1")).toBe("conn1");
  });
});
