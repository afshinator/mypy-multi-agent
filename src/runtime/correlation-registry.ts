import type { A2AEnvelope } from "../contracts/a2a-schema";

export class CorrelationTimeoutError extends Error {
  constructor(id: string) {
    super(`correlation ${id} timed out`);
    this.name = "CorrelationTimeoutError";
  }
}

/**
 * Single authority for request/response correlation. Opens a waiter keyed by
 * correlationId; resolve() completes it, fail() rejects it, and a late or
 * duplicate resolve/fail is a safe no-op.
 */
export class CorrelationRegistry {
  private waiters = new Map<
    string,
    { resolve: (msg: A2AEnvelope) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  open(correlationId: string, timeoutMs: number): Promise<A2AEnvelope> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(correlationId);
        reject(new CorrelationTimeoutError(correlationId));
      }, timeoutMs);
      this.waiters.set(correlationId, { resolve, reject, timer });
    });
  }

  resolve(correlationId: string, msg: A2AEnvelope): void {
    const w = this.waiters.get(correlationId);
    if (!w) return;
    this.waiters.delete(correlationId);
    clearTimeout(w.timer);
    w.resolve(msg);
  }

  fail(correlationId: string, reason: string): void {
    const w = this.waiters.get(correlationId);
    if (!w) return;
    this.waiters.delete(correlationId);
    clearTimeout(w.timer);
    w.reject(new Error(reason));
  }
}
