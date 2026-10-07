/**
 * Publishes the canonical agent state as herdr pane metadata tokens for the
 * collapsed pane view.
 */
import type { HerdrClient } from "./herdr-client";

export interface AgentStatus {
  state: string;
  cost?: string;
  tokens?: string;
  title?: string;
}

export class StatusAdapter {
  constructor(
    private readonly client: HerdrClient,
    private readonly source: string,
  ) {}

  setStatus(paneId: string, status: AgentStatus): Promise<void> {
    return this.client.reportMetadata(paneId, this.source, {
      state: status.state,
      cost: status.cost,
      tokens: status.tokens,
      title: status.title,
    });
  }
}
