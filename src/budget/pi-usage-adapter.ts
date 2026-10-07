/**
 * Single ingestion point for usage numbers (synthetic tests and the live peer
 * harness). Distinguishes "no numbers reported" from a recorded zero.
 */
import { UsageAccounting } from "./usage-accounting";
import type { IsFreeModel } from "./pricing-resolver";

export interface UsageRecord {
  agentId: string;
  model: string;
  cost?: number;
  tokens?: number;
}

/**
 * Single entry point that both producers (synthetic in L7, the live peer
 * harness in L8) feed. A priced call with no usage numbers logs a usage-gap
 * instead of recording zero; a free model's tokens are still counted at cost 0.
 */
export class PiUsageAdapter {
  constructor(
    private readonly accounting: UsageAccounting,
    private readonly isFree: IsFreeModel,
    private readonly log: (entry: Record<string, unknown>) => void,
  ) {}

  record(r: UsageRecord): void {
    if (r.cost === undefined && r.tokens === undefined) {
      if (!this.isFree(r.model)) {
        this.log({ event: "usage-gap", agentId: r.agentId, model: r.model });
      }
      return;
    }
    this.accounting.recordUsage({
      agentId: r.agentId,
      cost: r.cost ?? 0,
      tokens: r.tokens ?? 0,
    });
  }
}
