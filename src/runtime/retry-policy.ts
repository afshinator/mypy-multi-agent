export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly delayMs: (attempt: number) => number;
}

/** ACK timeout 10s, 2 retries (3 attempts total), no backoff. */
export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 10_000,
  delayMs: () => 0,
};
