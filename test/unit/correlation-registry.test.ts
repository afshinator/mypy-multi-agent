/**
 * Unit tests for the correlation registry module.
 */
import { describe, expect, it, vi } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { CorrelationRegistry } from "../../src/runtime/correlation-registry";

const env = (id: string): A2AEnvelope => ({
  id,
  timestamp: 0,
  sender: "s",
  recipient: "r",
  type: "ACK",
  payload: { taskId: "t1" },
});

describe("CorrelationRegistry", () => {
  it("matching resolve completes the waiter", async () => {
    const r = new CorrelationRegistry();
    const p = r.open("c1", 1000);
    r.resolve("c1", env("a"));
    await expect(p).resolves.toEqual(env("a"));
  });

  it("non-matching id does not resolve", async () => {
    const r = new CorrelationRegistry();
    const p = r.open("c1", 50);
    r.resolve("c2", env("a"));
    await expect(p).rejects.toThrow();
  });

  it("timeout rejects", async () => {
    const r = new CorrelationRegistry();
    await expect(r.open("c1", 10)).rejects.toThrow();
  });

  it("fail rejects immediately", async () => {
    const r = new CorrelationRegistry();
    const p = r.open("c1", 1000);
    r.fail("c1", "crashed");
    await expect(p).rejects.toThrow("crashed");
  });

  it("second resolve is ignored", async () => {
    const r = new CorrelationRegistry();
    const p = r.open("c1", 1000);
    r.resolve("c1", env("a"));
    r.resolve("c1", env("b"));
    await expect(p).resolves.toEqual(env("a"));
  });

  it("failAll rejects every open waiter", async () => {
    const r = new CorrelationRegistry();
    const p1 = r.open("c1", 1000);
    const p2 = r.open("c2", 1000);
    r.failAll("session stopped");
    await expect(p1).rejects.toThrow("session stopped");
    await expect(p2).rejects.toThrow("session stopped");
  });

  it("failAll after resolve leaves nothing pending", async () => {
    const r = new CorrelationRegistry();
    const p = r.open("c1", 1000);
    r.resolve("c1", env("a"));
    r.failAll("stopped");
    await expect(p).resolves.toEqual(env("a"));
  });
});

// Issue #141 follow-up: StrykerJS found that deleting the bookkeeping in
// open/resolve/failWith/failAll/timeout changes nothing any test observed, so
// the map could stop being emptied and the timers could stop being cleared.
// hasWaiter and the fake-timer count are the two behavioural observations that
// separate "rejected" from "cleaned up".
describe("CorrelationRegistry cleanup", () => {
  const withFakeTimers = async (body: () => Promise<void>) => {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  };

  it("empties the map and clears the timer on resolve", async () => {
    await withFakeTimers(async () => {
      const r = new CorrelationRegistry();
      const p = r.open("c1", 1000);
      r.resolve("c1", env("a"));
      await p;
      expect(r.hasWaiter("c1")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("empties the map and clears the timer on fail", async () => {
    await withFakeTimers(async () => {
      const r = new CorrelationRegistry();
      const p = r.open("c1", 1000);
      r.fail("c1", "crashed");
      await expect(p).rejects.toThrow("crashed");
      expect(r.hasWaiter("c1")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("empties the map and clears the timer on failWith", async () => {
    await withFakeTimers(async () => {
      const r = new CorrelationRegistry();
      const p = r.open("c1", 1000);
      r.failWith("c1", new Error("typed"));
      await expect(p).rejects.toThrow("typed");
      expect(r.hasWaiter("c1")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("empties every waiter and clears every timer on failAll", async () => {
    await withFakeTimers(async () => {
      const r = new CorrelationRegistry();
      const a = r.open("c1", 1000);
      const b = r.open("c2", 2000);
      r.failAll("stopped");
      await expect(a).rejects.toThrow("stopped");
      await expect(b).rejects.toThrow("stopped");
      expect(r.hasWaiter("c1")).toBe(false);
      expect(r.hasWaiter("c2")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("empties the map and clears the timer when the timeout fires", async () => {
    await withFakeTimers(async () => {
      const r = new CorrelationRegistry();
      const p = r.open("c1", 10);
      const settled = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(10);
      await settled;
      expect(r.hasWaiter("c1")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
