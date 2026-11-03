/**
 * Turn liveness for a peer, in one place (#166). It used to be four maps and a
 * `HeartbeatMonitor` spread across the socket dispatcher, the budget enforcer
 * and the restart path, reachable only through a real bus.
 *
 * Two clocks live here and they are not the same clock: `beat` says the peer is
 * reachable at all, and `progress` says its current turn is still moving. A peer
 * mid-way through a long tool call is reachable and not progressing.
 */
export class TurnState {
  /** Last heartbeat per agent; absent means no connection has ever beaten. */
  private readonly lastBeat = new Map<string, number>();
  /** Last turn progress (runtime clock) per agent with an open turn. */
  private readonly clocks = new Map<string, number>();
  /** Last explicit progress tick — a tool started or finished, not merely busy. */
  private readonly ticks = new Map<string, number>();
  /** Agents already flagged stalled this episode, so a stall is reported once. */
  private readonly stalled = new Set<string>();
  /** Agents over the stop threshold, waiting for their work order to finish. */
  private readonly deferred = new Set<string>();

  constructor(private readonly heartbeatTimeoutMs = 3000) {}

  /**
   * A heartbeat: the peer is reachable. This says nothing about its turn, so a
   * terminal peer's late beat still refreshes liveness without re-arming the
   * stall scan.
   */
  beat(agentId: string, now: number): void {
    this.lastBeat.set(agentId, now);
  }

  /**
   * Turn progress for a busy peer. The first busy beat opens the turn; later bare
   * beats leave its clock alone, and only an explicit `tick` (a tool started or
   * finished) restamps it.
   */
  progress(agentId: string, now: number, tick = false): void {
    if (tick) {
      this.clocks.set(agentId, now);
      this.ticks.set(agentId, now);
      this.stalled.delete(agentId);
      return;
    }
    if (!this.clocks.has(agentId)) this.clocks.set(agentId, now);
  }

  /** The turn ended (idle peer, crash, stop, or a fresh restart). */
  idle(agentId: string): void {
    this.clocks.delete(agentId);
    this.ticks.delete(agentId);
    this.stalled.delete(agentId);
  }

  /**
   * Drop everything about a peer. A reconnect must not be judged by a prior
   * connection's silence or by a stop deferred for its predecessor.
   */
  forget(agentId: string): void {
    this.idle(agentId);
    this.lastBeat.delete(agentId);
    this.deferred.delete(agentId);
  }

  isBusy(agentId: string): boolean {
    return this.clocks.has(agentId);
  }

  progressAt(agentId: string): number | undefined {
    return this.clocks.get(agentId);
  }

  lastTickAt(agentId: string): number | undefined {
    return this.ticks.get(agentId);
  }

  isStalled(agentId: string): boolean {
    return this.stalled.has(agentId);
  }

  /** Agents whose heartbeat lapsed at `now`; each fires at most once. */
  lapsed(now: number): string[] {
    const out: string[] = [];
    for (const [agentId, last] of this.lastBeat) {
      if (now - last >= this.heartbeatTimeoutMs) {
        out.push(agentId);
        this.lastBeat.delete(agentId);
      }
    }
    return out;
  }

  /**
   * Open turns whose progress age crossed their deadline, with the age. A peer
   * already flagged is not returned again; a deadline of `0` disables the scan
   * for that agent (the free-class override is allowed to disable it).
   */
  overdue(
    deadlineMs: (agentId: string) => number,
    now: number,
  ): { agentId: string; elapsedMs: number }[] {
    const out: { agentId: string; elapsedMs: number }[] = [];
    for (const [agentId, progressAt] of this.clocks) {
      const deadline = deadlineMs(agentId);
      if (deadline <= 0 || this.stalled.has(agentId)) continue;
      const elapsedMs = now - progressAt;
      if (elapsedMs >= deadline) out.push({ agentId, elapsedMs });
    }
    return out;
  }

  markStalled(agentId: string): void {
    this.stalled.add(agentId);
  }

  /** The deferred-stop latch. *When* to defer is the caller's budget question. */
  deferStop(agentId: string): void {
    this.deferred.add(agentId);
  }

  takeDeferredStop(agentId: string): boolean {
    return this.deferred.delete(agentId);
  }

  /** Ids with a deferred stop, so the budget check does not re-report them. */
  deferredStops(): string[] {
    return [...this.deferred];
  }
}
