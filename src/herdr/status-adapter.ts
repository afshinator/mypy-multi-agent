/**
 * Publishes the canonical agent state as herdr pane metadata tokens for the
 * collapsed pane view.
 */
import type { HerdrClient } from "./herdr-client";

export interface AgentStatus {
  state: string;
  cost?: string;
  tokens?: string;
  role?: string;
  model?: string;
  title?: string;
  displayAgent?: string;
}

/**
 * Compose the visible pane label (herdr `--display-agent`): role, model, and
 * usage. Unset fields are omitted. This is what herdr renders in the default
 * `[agent]` sidebar row; the `--token` role/model/state/cost/tokens pairs are
 * not rendered unless the user configures `$role`/`$model`/... in
 * `ui.sidebar.agents.rows`.
 */
export function composeDisplayAgent(
  status: Pick<AgentStatus, "role" | "model" | "tokens" | "cost">,
): string {
  const parts: string[] = [];
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
      state: status.state,
      cost: status.cost,
      tokens: status.tokens,
      role: status.role,
      model: status.model,
      displayAgent: status.displayAgent ?? composeDisplayAgent(status),
      title: status.title,
    });
  }
}
