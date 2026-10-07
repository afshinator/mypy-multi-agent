/**
 * Unit tests for the malformed counter module.
 */
import { describe, expect, it, vi } from "vitest";
import { MalformedCounter } from "../../src/bus/malformed-counter";

describe("MalformedCounter", () => {
  it("emits fault at threshold within window", () => {
    const sink = { onProtocolFault: vi.fn() };
    const c = new MalformedCounter(5, 60_000, sink);
    for (let i = 0; i < 4; i++) expect(c.record(i)).toBe(false);
    expect(c.record(4)).toBe(true);
    expect(sink.onProtocolFault).toHaveBeenCalledOnce();
  });

  it("does not emit when spread beyond the window", () => {
    const sink = { onProtocolFault: vi.fn() };
    const c = new MalformedCounter(5, 60_000, sink);
    for (let i = 0; i < 5; i++) c.record(i * 60_001);
    expect(sink.onProtocolFault).not.toHaveBeenCalled();
  });

  it("re-arms after firing", () => {
    const sink = { onProtocolFault: vi.fn() };
    const c = new MalformedCounter(2, 60_000, sink);
    expect(c.record(0)).toBe(false);
    expect(c.record(1)).toBe(true);
    expect(c.record(2)).toBe(false);
    expect(c.record(3)).toBe(true);
    expect(sink.onProtocolFault).toHaveBeenCalledTimes(2);
  });
});
