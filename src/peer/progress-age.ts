/**
 * Pure formatting for the peer's live turn-progress indicator. The peer owns
 * the clock, so these helpers stay free of I/O and are unit-tested directly.
 */

/** Coarse step for title refreshes. The pane title only redraws when the age
 * crosses a bucket boundary, so a live turn does not spawn a herdr process per
 * second (each report is an `execFile("herdr", ...)`). */
export const PROGRESS_BUCKET_MS = 15_000;

/** Short age label: `12s` under a minute, `3m` under an hour, `1h05m` beyond. */
export function formatProgressAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Display-only state for an open turn. `STALLED` when the age reaches the A5
 * threshold (`stallTimeoutMs`); a non-positive threshold disables the label.
 * The canonical state stays `WORKING`; this value only tints the pane title.
 * shortcut: runtime.ts A5 repeats this comparison cross-process; do not share it. */
export function turnDisplayState(ageMs: number, stallTimeoutMs: number): "WORKING" | "STALLED" {
  return stallTimeoutMs > 0 && ageMs >= stallTimeoutMs ? "STALLED" : "WORKING";
}

/** Bucket index of an age; equal indices mean the indicator has not visibly
 * advanced, so the title can be left alone. */
export function progressBucket(ageMs: number): number {
  return Math.floor(Math.max(0, ageMs) / PROGRESS_BUCKET_MS);
}
