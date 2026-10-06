export interface ProtocolFaultSink {
  onProtocolFault(count: number): void;
}

/**
 * Sliding-window malformed-frame counter. Emits a protocol fault once the
 * threshold is hit within the window, then re-arms.
 */
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
      this.timestamps = [];
      this.sink?.onProtocolFault(this.threshold);
      return true;
    }
    return false;
  }
}
