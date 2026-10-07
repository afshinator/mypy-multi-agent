/**
 * Publishes the canonical agent state as the herdr pane title for the collapsed
 * pane view. `--title` is the only field that renders on a plain (non-agent)
 * pane, and every report carries it so herdr never records a cleared title.
 */
import type { HerdrClient } from "./herdr-client";

export interface AgentStatus {
  id?: string;
  state: string;
  cost?: string;
  tokens?: string;
  role?: string;
  model?: string;
}

/** Pane title (herdr `--title`): id · state · role · model · tokens · cost. */
export function composeDisplayAgent(
  status: Pick<AgentStatus, "id" | "state" | "role" | "model" | "tokens" | "cost">,
): string {
  const parts: string[] = [];
  if (status.id) parts.push(status.id);
  if (status.state) parts.push(status.state);
  if (status.role) parts.push(status.role);
  if (status.model) parts.push(status.model);
  if (status.tokens) parts.push(`${status.tokens} tok`);
  if (status.cost) parts.push(`$${status.cost}`);
  return parts.join(" · ");
}

export class StatusAdapter {
  constructor(
    private readonly client: HerdrClient,
    private readonly source: string,
  ) {}

  setStatus(paneId: string, status: AgentStatus): Promise<void> {
    return this.client.reportMetadata(paneId, this.source, {
      title: composeDisplayAgent(status),
    });
  }
}
