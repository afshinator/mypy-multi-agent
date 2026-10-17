/**
 * Fires a peer state label to herdr and swallows the rejection: pane status is
 * cosmetic, so a failed `report-metadata` (pane gone, herdr restarting) must not
 * become an unhandled rejection that kills the peer mid-turn.
 */
import type { StatusAdapter } from "../herdr/status-adapter";

export interface PeerStatusAgent {
  agentId: string;
  title: string;
  model: string;
}

export function writePeerStatus(
  status: StatusAdapter,
  paneId: string,
  agent: PeerStatusAgent,
  state: string,
  cost?: string,
  tokens?: string,
  progress?: string,
  displayState?: string,
): void {
  void status
    .setStatus(paneId, {
      id: agent.agentId,
      state,
      displayState,
      cost,
      tokens,
      role: agent.title,
      model: agent.model,
      progress,
    })
    .catch(() => {});
}
