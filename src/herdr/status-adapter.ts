/**
 * Publishes the canonical agent state as the herdr pane title for the collapsed
 * pane view. `--title` is the only field that renders on a plain (non-agent)
 * pane, and every report carries it so herdr never records a cleared title.
 */
import type { HerdrClient } from "./herdr-client";

export interface AgentStatus {
  id?: string;
  state: string;
  /** Display-only state for the title; the token map always keeps `state`. */
  displayState?: string;
  cost?: string;
  tokens?: string;
  role?: string;
  model?: string;
  /** Short age label since the last turn-progress event, e.g. `12s`, `3m`. */
  progress?: string;
}

/** Pane title (herdr `--title`): id · displayState [progress] · role · model · tokens · cost. */
export function composeDisplayAgent(
  status: Pick<
    AgentStatus,
    "id" | "state" | "displayState" | "role" | "model" | "tokens" | "cost" | "progress"
  >,
): string {
  const parts: string[] = [];
  if (status.id) parts.push(status.id);
  const state = status.displayState ?? status.state;
  if (state) parts.push(status.progress ? `${state} ${status.progress}` : state);
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
    const tokens: Record<string, string> = {};
    // §14.4: STOPPED is not self-reportable, so the peer must not publish the
    // canonical state token for it. The title still carries the label.
    if (status.state !== "STOPPED") tokens.state = status.state;
    if (status.role) tokens.role = status.role;
    if (status.model) tokens.model = status.model;
    if (status.tokens) tokens.tokens = status.tokens;
    if (status.cost) tokens.cost = status.cost;
    if (status.progress) tokens.progress = status.progress;
    return this.client.reportMetadata(paneId, this.source, {
      title: composeDisplayAgent(status),
      tokens,
    });
  }
}
