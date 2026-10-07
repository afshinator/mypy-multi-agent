/**
 * Unit tests for the correlation registry module.
 */
import { describe, expect, it } from "vitest";
import { CorrelationRegistry } from "../../src/runtime/correlation-registry";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

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
});
