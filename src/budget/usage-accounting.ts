/**
 * In-memory per-agent and session cost/token totals; the single source the
 * BudgetEnforcer reads.
 */
export interface UsageEvent {
  agentId: string;
  cost: number;
  tokens: number;
  /** Cache-read tokens already included in `tokens`; excluded from the token bound (RT-1). */
  cacheReadTokens?: number;
}

export class UsageAccounting {
  private cost = new Map<string, number>();
  private tokens = new Map<string, number>();
  private cacheRead = new Map<string, number>();

  recordUsage(event: UsageEvent): void {
    this.cost.set(event.agentId, (this.cost.get(event.agentId) ?? 0) + event.cost);
    this.tokens.set(event.agentId, (this.tokens.get(event.agentId) ?? 0) + event.tokens);
    if (event.cacheReadTokens) {
      this.cacheRead.set(
        event.agentId,
        (this.cacheRead.get(event.agentId) ?? 0) + event.cacheReadTokens,
      );
    }
  }

  getAgentCost(agentId: string): number {
    return this.cost.get(agentId) ?? 0;
  }

  /** Total tokens including cache reads — the reporting number in final.md. */
  getAgentTokens(agentId: string): number {
    return this.tokens.get(agentId) ?? 0;
  }

  /** Tokens that count against `max_tokens`: total minus cache re-reads. A
   * tool-loop run resends the context on every request and reports those reads
   * as cache-read tokens; counting them made a small cap look exhausted almost
   * immediately (RT-1). Never negative. */
  getAgentBoundTokens(agentId: string): number {
    return Math.max(0, this.getAgentTokens(agentId) - (this.cacheRead.get(agentId) ?? 0));
  }

  /** Raw cache-read tokens recorded for `agentId`, before the bound subtraction. */
  getAgentCacheReadTokens(agentId: string): number {
    return this.cacheRead.get(agentId) ?? 0;
  }

  /** Snapshot restore: SET totals (not accumulate), so cost/tokens/cache reads
   * round-trip exactly across a resume. */
  restore(usage: readonly UsageEvent[]): void {
    this.cost.clear();
    this.tokens.clear();
    this.cacheRead.clear();
    for (const u of usage) {
      this.cost.set(u.agentId, u.cost);
      this.tokens.set(u.agentId, u.tokens);
      if (u.cacheReadTokens !== undefined && u.cacheReadTokens !== 0) {
        this.cacheRead.set(u.agentId, u.cacheReadTokens);
      }
    }
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
