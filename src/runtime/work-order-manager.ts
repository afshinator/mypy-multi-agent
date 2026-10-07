/**
 * At-least-once work-order delivery (retry on timeout only) with at-most-once
 * execution per taskId.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";
import { CorrelationRegistry, CorrelationTimeoutError } from "./correlation-registry";
import type { RetryPolicy } from "./retry-policy";
import type { PendingRequestFailureSink } from "../bus/router";

export interface WorkOrder {
  taskId: string;
  action: string;
  contextFiles: string[];
  constraints: string[];
  localDoD: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reliable work-order dispatch: retried at-least-once delivery (timeout only)
 * with at-most-once execution per work-order ID (dedup via completed set).
 * The correlation ID equals the work-order taskId and is stable across retries.
 */
export class WorkOrderManager {
  private completed = new Map<string, A2AEnvelope>();

  constructor(
    private readonly registry: CorrelationRegistry,
    private readonly policy: RetryPolicy,
    private readonly send: (correlationId: string, workOrder: WorkOrder) => void,
  ) {}

  async deliver(workOrder: WorkOrder): Promise<A2AEnvelope> {
    const id = workOrder.taskId;
    const cached = this.completed.get(id);
    if (cached) return cached;

    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt++) {
      const ack = this.registry.open(id, this.policy.timeoutMs);
      this.send(id, workOrder);
      try {
        const result = await ack;
        this.completed.set(id, result);
        return result;
      } catch (err) {
        if (attempt < this.policy.maxAttempts && err instanceof CorrelationTimeoutError) {
          const d = this.policy.delayMs(attempt);
          if (d > 0) await sleep(d);
          continue;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  /** Wire L1's F2 failure seam to fail an in-flight correlation immediately. */
  failureSink(): PendingRequestFailureSink {
    return {
      fail: (correlationId, reason) => {
        if (correlationId !== undefined) this.registry.fail(correlationId, reason);
      },
    };
  }
}
