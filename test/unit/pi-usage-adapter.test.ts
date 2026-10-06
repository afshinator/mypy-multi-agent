import { describe, expect, it, vi } from "vitest";
import { PiUsageAdapter } from "../../src/budget/pi-usage-adapter";
import { UsageAccounting } from "../../src/budget/usage-accounting";

describe("PiUsageAdapter", () => {
  it("records full usage into accounting", () => {
    const acct = new UsageAccounting();
    const a = new PiUsageAdapter(acct, () => false, vi.fn());
    a.record({ agentId: "a", model: "m", cost: 2, tokens: 100 });
    expect(acct.getAgentCost("a")).toBe(2);
    expect(acct.getAgentTokens("a")).toBe(100);
  });

  it("priced call with missing usage logs a gap and does not zero", () => {
    const acct = new UsageAccounting();
    acct.recordUsage({ agentId: "a", cost: 5, tokens: 100 });
    const log = vi.fn();
    const a = new PiUsageAdapter(acct, (m) => m === "free", log);
    a.record({ agentId: "a", model: "priced" });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatchObject({ event: "usage-gap", agentId: "a" });
    expect(acct.getAgentCost("a")).toBe(5);
  });

  it("free model with tokens but no cost records tokens at zero cost", () => {
    const acct = new UsageAccounting();
    const a = new PiUsageAdapter(acct, (m) => m === "free", vi.fn());
    a.record({ agentId: "a", model: "free", tokens: 100 });
    expect(acct.getAgentTokens("a")).toBe(100);
    expect(acct.getAgentCost("a")).toBe(0);
  });
});
