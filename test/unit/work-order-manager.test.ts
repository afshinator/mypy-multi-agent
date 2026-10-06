import { describe, expect, it, vi } from "vitest";
import { CorrelationRegistry } from "../../src/runtime/correlation-registry";
import { WorkOrderManager, type WorkOrder } from "../../src/runtime/work-order-manager";
import type { RetryPolicy } from "../../src/runtime/retry-policy";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

const wo: WorkOrder = { taskId: "t1", action: "a", contextFiles: [], constraints: [], localDoD: "d" };

const ack: A2AEnvelope = {
  id: "ack1",
  correlationId: "t1",
  timestamp: 0,
  sender: "peer",
  recipient: "supervisor",
  type: "ACK",
  payload: { taskId: "t1" },
};

const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts: 3,
  timeoutMs: 1000,
  delayMs: () => 0,
  ...over,
});

describe("WorkOrderManager", () => {
  it("ACK on first try", async () => {
    const r = new CorrelationRegistry();
    const send = vi.fn((id: string) => r.resolve(id, ack));
    const m = new WorkOrderManager(r, policy(), send);
    await expect(m.deliver(wo)).resolves.toBe(ack);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ACK after retry", async () => {
    const r = new CorrelationRegistry();
    let calls = 0;
    const send = vi.fn((id: string) => {
      if (++calls === 2) r.resolve(id, ack);
    });
    const m = new WorkOrderManager(r, policy({ timeoutMs: 20 }), send);
    await expect(m.deliver(wo)).resolves.toBe(ack);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("no ACK exhausts attempts", async () => {
    const r = new CorrelationRegistry();
    const send = vi.fn();
    const m = new WorkOrderManager(r, policy({ timeoutMs: 10 }), send);
    await expect(m.deliver(wo)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("crash before ACK fails immediately, no retry", async () => {
    const r = new CorrelationRegistry();
    const send = vi.fn((id: string) => r.fail(id, "crashed"));
    const m = new WorkOrderManager(r, policy(), send);
    await expect(m.deliver(wo)).rejects.toThrow("crashed");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("duplicate work order re-ACKs but sends once", async () => {
    const r = new CorrelationRegistry();
    const send = vi.fn((id: string) => r.resolve(id, ack));
    const m = new WorkOrderManager(r, policy(), send);
    await expect(m.deliver(wo)).resolves.toBe(ack);
    await expect(m.deliver(wo)).resolves.toBe(ack);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("late duplicate ACK is harmless", async () => {
    const r = new CorrelationRegistry();
    const send = vi.fn((id: string) => r.resolve(id, ack));
    const m = new WorkOrderManager(r, policy(), send);
    await m.deliver(wo);
    expect(() => r.resolve("t1", ack)).not.toThrow();
  });

  it("F2 failure seam fails the in-flight correlation immediately", async () => {
    const r = new CorrelationRegistry();
    const send = vi.fn();
    const m = new WorkOrderManager(r, policy(), send);
    const p = m.deliver(wo);
    m.failureSink().fail("t1", "invalid payload");
    await expect(p).rejects.toThrow("invalid payload");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
