/**
 * Retry shape for at-least-once work-order delivery (attempts, timeout, backoff).
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly delayMs: (attempt: number) => number;
}
