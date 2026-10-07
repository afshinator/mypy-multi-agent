/**
 * Unit tests for the list_agents formatter (cost/token visibility).
 */
import { describe, expect, it } from "vitest";
import { formatAgents } from "../../src/pi/extension";
import { UsageAccounting } from "../../src/budget/usage-accounting";

describe("formatAgents", () => {
  it("renders id, state, cost, and tokens per agent", () => {
    const accounting = new UsageAccounting();
    accounting.recordUsage({ agentId: "dev_a", cost: 0.42, tokens: 1234 });
    accounting.recordUsage({ agentId: "dev_b", cost: 0, tokens: 50 });
    const out = formatAgents(["dev_a", "dev_b"], new Map([["dev_a", "DONE"], ["dev_b", "WORKING"]]), accounting);
    expect(out).toContain("- dev_a (DONE) — $0.4200 / 1234 tokens");
    expect(out).toContain("- dev_b (WORKING) — $0.0000 / 50 tokens");
  });
});
