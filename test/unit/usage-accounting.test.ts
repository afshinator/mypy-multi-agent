/**
 * Unit tests for the usage accounting module.
 */
import { describe, expect, it } from "vitest";
import { UsageAccounting } from "../../src/budget/usage-accounting";

describe("UsageAccounting", () => {
  it("accumulates per-agent cost and tokens", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "a", cost: 1, tokens: 100 });
    a.recordUsage({ agentId: "a", cost: 2, tokens: 50 });
    a.recordUsage({ agentId: "b", cost: 3, tokens: 200 });
    expect(a.getAgentCost("a")).toBe(3);
    expect(a.getAgentTokens("a")).toBe(150);
    expect(a.getSessionCost()).toBe(6);
    expect(a.getSessionTokens()).toBe(350);
  });

  it("supervisor contributes to the global total", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "supervisor", cost: 2, tokens: 300 });
    a.recordUsage({ agentId: "peer", cost: 1, tokens: 100 });
    expect(a.getSessionCost()).toBe(3);
  });

  it("unknown agent returns 0", () => {
    const a = new UsageAccounting();
    expect(a.getAgentCost("x")).toBe(0);
    expect(a.getAgentTokens("x")).toBe(0);
    expect(a.getAgentBoundTokens("x")).toBe(0);
  });

  it("token bound excludes cache reads, total keeps them (RT-1)", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "a", cost: 0, tokens: 1_000_000, cacheReadTokens: 970_000 });
    expect(a.getAgentTokens("a")).toBe(1_000_000);
    expect(a.getAgentBoundTokens("a")).toBe(30_000);
  });

  it("token bound never goes negative", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "a", cost: 0, tokens: 100, cacheReadTokens: 500 });
    expect(a.getAgentBoundTokens("a")).toBe(0);
  });
});
