/**
 * Budget policy: OR'd cost/token thresholds per agent plus the global session
 * ceiling, and the bounded finalization overrun window. Reads UsageAccounting.
 */
import { UsageAccounting } from "./usage-accounting";

export interface AgentBudget {
  agentId: string;
  maxCostUsd: number;
  maxTokens?: number;
}

export interface BudgetConfig {
  agents: AgentBudget[];
  sessionMaxCostUsd: number;
  thresholdPercent: number;
}

export type BudgetViolation =
  | { kind: "agent"; agentId: string; bound: "cost" | "tokens"; percent: number }
  | { kind: "global"; percent: number };

/**
 * Thresholds are OR'd: cost% and token% are checked independently and the
 * first bound to reach thresholdPercent trips. Global session cost trips at
 * 100% of sessionMaxCostUsd.
 */
export class BudgetEnforcer {
  constructor(
    private readonly accounting: UsageAccounting,
    private readonly config: BudgetConfig,
  ) {}

  check(): BudgetViolation | undefined {
    for (const a of this.config.agents) {
      const costPct = (this.accounting.getAgentCost(a.agentId) / a.maxCostUsd) * 100;
      if (costPct >= this.config.thresholdPercent) {
        return { kind: "agent", agentId: a.agentId, bound: "cost", percent: costPct };
      }
      if (a.maxTokens !== undefined) {
        const tokenPct = (this.accounting.getAgentTokens(a.agentId) / a.maxTokens) * 100;
        if (tokenPct >= this.config.thresholdPercent) {
          return { kind: "agent", agentId: a.agentId, bound: "tokens", percent: tokenPct };
        }
      }
    }
    const globalPct = (this.accounting.getSessionCost() / this.config.sessionMaxCostUsd) * 100;
    if (globalPct >= 100) return { kind: "global", percent: globalPct };
    return undefined;
  }
}
