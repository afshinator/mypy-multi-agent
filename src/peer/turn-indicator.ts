/**
 * Pure turn-progress indicator for the peer's pane title. Owns the last-progress
 * instant, the coarse age bucket, and the last published display state so the
 * throttle and WORKING→STALLED transitions are one clock-injected module the
 * peer process wires to herdr. No I/O, no ambient clock.
 */
import { formatProgressAge, progressBucket, turnDisplayState } from "./progress-age";

export interface TurnIndicatorView {
  state: "WORKING";
  displayState: "WORKING" | "STALLED";
  progress: string;
}

export class TurnIndicator {
  private lastProgressAt: number;
  private lastBucket: number | undefined;
  private lastDisplayState: TurnIndicatorView["displayState"] | undefined;

  constructor(now: number) {
    this.lastProgressAt = now;
  }

  /** Stamp the last-progress instant; `progressed` false leaves it alone. */
  observe(progressed: boolean, now: number): void {
    if (progressed) this.lastProgressAt = now;
  }

  /** Restart the clock for a new turn and force the next `view` to emit. */
  reset(now: number): void {
    this.lastProgressAt = now;
    this.lastBucket = undefined;
    this.lastDisplayState = undefined;
  }

  /** The pane view for an open turn, or undefined when a redraw would repeat
   * the last one (same age bucket, same display state). */
  view(busy: boolean, now: number, stallTimeoutMs: number): TurnIndicatorView | undefined {
    if (!busy) return undefined;
    const age = now - this.lastProgressAt;
    const bucket = progressBucket(age);
    const displayState = turnDisplayState(age, stallTimeoutMs);
    if (bucket === this.lastBucket && displayState === this.lastDisplayState) return undefined;
    this.lastBucket = bucket;
    this.lastDisplayState = displayState;
    return { state: "WORKING", displayState, progress: formatProgressAge(age) };
  }
}
