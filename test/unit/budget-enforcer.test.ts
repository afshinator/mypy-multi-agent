/**
 * Unit tests for the budget enforcer module.
 */
import { describe, expect, it } from "vitest";
import { BudgetEnforcer, type BudgetConfig } from "../../src/budget/budget-enforcer";
import { UsageAccounting } from "../../src/budget/usage-accounting";

const cfg = (over: Partial<BudgetConfig> = {}): BudgetConfig => ({
  agents: [{ agentId: "a", maxCostUsd: 10, maxTokens: 100 }],
  sessionMaxCostUsd: 50,
  thresholdPercent: 85,
  ...over,
});

describe("BudgetEnforcer", () => {
  it("no violation under threshold", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "a", cost: 5, tokens: 50 });
    expect(new BudgetEnforcer(a, cfg()).check()).toBeUndefined();
  });

  it("peer cost threshold trips", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "a", cost: 8.6, tokens: 0 });
    expect(new BudgetEnforcer(a, cfg()).check()).toMatchObject({ kind: "agent", agentId: "a", bound: "cost" });
  });

  it("peer token threshold trips on a free model", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "a", cost: 0, tokens: 90 });
    expect(new BudgetEnforcer(a, cfg()).check()).toMatchObject({ kind: "agent", agentId: "a", bound: "tokens" });
  });

  it("whichever bound trips first wins", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "a", cost: 1, tokens: 85 });
    expect(new BudgetEnforcer(a, cfg()).check()).toMatchObject({ bound: "tokens" });
  });

  it("free model: cost 0, tokens counted, token threshold trips at 85%", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "a", cost: 0, tokens: 85 });
    expect(new BudgetEnforcer(a, cfg()).check()).toMatchObject({ bound: "tokens" });
  });

  it("global threshold trips when session cost is exhausted", () => {
    const a = new UsageAccounting();
    a.recordUsage({ agentId: "a", cost: 20, tokens: 0 });
    a.recordUsage({ agentId: "b", cost: 31, tokens: 0 });
    const e = new BudgetEnforcer(a, {
      agents: [
        { agentId: "a", maxCostUsd: 100 },
        { agentId: "b", maxCostUsd: 100 },
      ],
      sessionMaxCostUsd: 50,
      thresholdPercent: 85,
    });
    expect(e.check()).toMatchObject({ kind: "global" });
  });
});
