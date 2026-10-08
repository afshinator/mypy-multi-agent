/**
 * Unit tests for the heartbeat monitor module.
 */
import { describe, expect, it } from "vitest";
import { HeartbeatMonitor } from "../../src/runtime/heartbeat-monitor";

describe("HeartbeatMonitor", () => {
  it("healthy heartbeat never times out", () => {
    const m = new HeartbeatMonitor(3000);
    for (let t = 0; t < 10000; t += 1000) {
      m.beat("a", t);
      expect(m.check(t)).toEqual([]);
    }
  });

  it("silence to timeout marks unreachable at the deadline", () => {
    const m = new HeartbeatMonitor(3000);
    m.beat("a", 0);
    expect(m.check(2999)).toEqual([]);
    expect(m.check(3000)).toEqual(["a"]);
  });

  it("does not re-fire after removal", () => {
    const m = new HeartbeatMonitor(3000);
    m.beat("a", 0);
    expect(m.check(3000)).toEqual(["a"]);
    expect(m.check(6000)).toEqual([]);
  });
});
