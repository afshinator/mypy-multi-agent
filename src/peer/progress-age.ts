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

/** Bucket index of an age; equal indices mean the indicator has not visibly
 * advanced, so the title can be left alone. */
export function progressBucket(ageMs: number, stepMs: number = PROGRESS_BUCKET_MS): number {
  return Math.floor(Math.max(0, ageMs) / stepMs);
}
