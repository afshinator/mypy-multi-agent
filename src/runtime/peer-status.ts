/**
 * Live peer turn state for the supervisor (issue #4). The runtime already derives
 * this from the heartbeat for the pane title (A5/#2); the same numbers are exposed
 * to the supervisor so it can see a peer is busy instead of sending it a `ping`
 * PROMPT, which runs as a full extra turn.
 *
 * Pure and derived from state already in memory: no new bus message, no prompt.
 */
export interface PeerStatus {
  agentId: string;
  /** Canonical agent state (WORKING/IDLE/CRASHED/...). */
  state: string;
  /** True while a turn is open (a progress clock exists for the agent). */
  busy: boolean;
  /** Milliseconds since the last turn-progress event while busy; null when idle. */
  progressAgeMs: number | null;
  /** A5: the agent has been marked stalled (progress age crossed the threshold). */
  stalled: boolean;
}

export function peerStatus(
  agentId: string,
  state: string,
  progressAtMs: number | undefined,
  stalled: boolean,
  now: number,
): PeerStatus {
  const busy = progressAtMs !== undefined;
  return {
    agentId,
    state,
    busy,
    progressAgeMs: busy ? Math.max(0, now - progressAtMs) : null,
    stalled,
  };
}
