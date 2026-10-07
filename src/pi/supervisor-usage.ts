/**
 * Sums the supervisor's own cost/tokens from its session entries; peers report
 * separately over the bus.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SupervisorUsage {
  costUsd: number;
  tokens: number;
}

/**
 * The supervisor's own spend: sum of assistant-message usage in its session.
 * Peers report separately over the bus; this covers only the supervisor's turns.
 */
export function sumSupervisorUsage(entries: SessionEntry[]): SupervisorUsage {
  let costUsd = 0;
  let tokens = 0;
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message as unknown as { role?: string; usage?: { cost?: { total?: number }; totalTokens?: number } };
    if (m.role === "assistant" && m.usage) {
      costUsd += m.usage.cost?.total ?? 0;
      tokens += m.usage.totalTokens ?? 0;
    }
  }
  return { costUsd, tokens };
}
