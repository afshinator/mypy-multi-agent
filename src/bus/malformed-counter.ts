/**
 * Sliding-window malformed-frame counter used by the bus as a circuit breaker.
 * Wired in src/runtime/runtime.ts; crossing the threshold triggers the
 * Supervisor's stop-on-protocol-fault policy.
 */
export interface ProtocolFaultSink {
  onProtocolFault(count: number): void;
}

export class MalformedCounter {
  private timestamps: number[] = [];

  constructor(
    private readonly threshold = 5,
    private readonly windowMs = 60_000,
    private readonly sink?: ProtocolFaultSink,
  ) {}

  /** Record one malformed frame at `now` (ms). Returns true when the fault fired. */
  record(now: number): boolean {
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    this.timestamps.push(now);
    if (this.timestamps.length >= this.threshold) {
      // Reset the whole window, not just the offending sample: this is a
      // circuit breaker, not a rate counter.
      this.timestamps = [];
      this.sink?.onProtocolFault(this.threshold);
      return true;
    }
    return false;
  }
}
