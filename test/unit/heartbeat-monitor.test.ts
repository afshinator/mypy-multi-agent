import { describe, expect, it, vi } from "vitest";
import { HeartbeatMonitor } from "../../src/runtime/heartbeat-monitor";

describe("HeartbeatMonitor", () => {
  it("healthy heartbeat never times out", () => {
    const sink = { onTimeout: vi.fn() };
    const m = new HeartbeatMonitor(3000, sink);
    for (let t = 0; t < 10000; t += 1000) {
      m.beat("a", t);
      m.check(t);
    }
    expect(sink.onTimeout).not.toHaveBeenCalled();
  });

  it("silence to timeout marks unreachable at the deadline", () => {
    const sink = { onTimeout: vi.fn() };
    const m = new HeartbeatMonitor(3000, sink);
    m.beat("a", 0);
    expect(m.check(2999)).toEqual([]);
    expect(m.check(3000)).toEqual(["a"]);
    expect(sink.onTimeout).toHaveBeenCalledWith("a");
  });

  it("does not re-fire after removal", () => {
    const sink = { onTimeout: vi.fn() };
    const m = new HeartbeatMonitor(3000, sink);
    m.beat("a", 0);
    m.check(3000);
    expect(m.check(6000)).toEqual([]);
    expect(sink.onTimeout).toHaveBeenCalledOnce();
  });
});
