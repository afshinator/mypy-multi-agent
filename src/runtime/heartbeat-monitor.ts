/**
 * Deadline-based liveness: an agent is unreachable when now - lastBeat >=
 * timeoutMs. `check` returns (and forgets) the timed-out ids, so each timeout
 * fires at most once and a later beat re-arms the id.
 */
export class HeartbeatMonitor {
  private lastBeat = new Map<string, number>();

  constructor(private readonly timeoutMs = 3000) {}

  beat(agentId: string, now: number): void {
    this.lastBeat.set(agentId, now);
  }

  /** Return the agent IDs that timed out at `now`; each fires at most once. */
  check(now: number): string[] {
    const timedOut: string[] = [];
    for (const [id, last] of this.lastBeat) {
      if (now - last >= this.timeoutMs) {
        timedOut.push(id);
        this.lastBeat.delete(id);
      }
    }
    return timedOut;
  }

  /** Drop a peer's last-beat so a reconnect isn't judged by a prior connection's silence. */
  forget(agentId: string): void {
    this.lastBeat.delete(agentId);
  }
}
