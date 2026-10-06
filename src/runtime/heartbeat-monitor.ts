export interface HeartbeatSink {
  onTimeout(agentId: string): void;
}

/**
 * Deadline-based heartbeat tracking. An agent is unreachable when
 * `now - lastBeat >= timeoutMs` (the deadline is the last received beat,
 * not the next expected one).
 */
export class HeartbeatMonitor {
  private lastBeat = new Map<string, number>();

  constructor(
    private readonly timeoutMs = 3000,
    private readonly sink?: HeartbeatSink,
  ) {}

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
    for (const id of timedOut) this.sink?.onTimeout(id);
    return timedOut;
  }
}
