/**
 * In-memory per-agent and session cost/token totals; the single source the
 * BudgetEnforcer reads.
 */
export interface UsageEvent {
  agentId: string;
  cost: number;
  tokens: number;
}

export class UsageAccounting {
  private cost = new Map<string, number>();
  private tokens = new Map<string, number>();

  recordUsage(event: UsageEvent): void {
    this.cost.set(event.agentId, (this.cost.get(event.agentId) ?? 0) + event.cost);
    this.tokens.set(event.agentId, (this.tokens.get(event.agentId) ?? 0) + event.tokens);
  }

  getAgentCost(agentId: string): number {
    return this.cost.get(agentId) ?? 0;
  }

  getAgentTokens(agentId: string): number {
    return this.tokens.get(agentId) ?? 0;
  }

  getSessionCost(): number {
    let total = 0;
    for (const v of this.cost.values()) total += v;
    return total;
  }

  getSessionTokens(): number {
    let total = 0;
    for (const v of this.tokens.values()) total += v;
    return total;
  }
}
