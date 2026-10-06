import { describe, expect, it, vi } from "vitest";
import { routeFrame } from "../../src/bus/router";

const env = (overrides: Record<string, unknown> = {}) => ({
  id: "e1",
  correlationId: "c1",
  timestamp: 1,
  sender: "s",
  recipient: "a",
  type: "HEARTBEAT",
  payload: { agentId: "a" },
  ...overrides,
});

function deps() {
  return {
    sink: { fail: vi.fn() },
    malformed: vi.fn(),
    sendError: vi.fn(),
    log: vi.fn(),
  };
}

describe("routeFrame", () => {
  it("F1: malformed frame, no ERROR, no sink", () => {
    const d = deps();
    const r = routeFrame("{bad", d);
    expect(r).toBe("f1");
    expect(d.malformed).toHaveBeenCalledOnce();
    expect(d.sink.fail).not.toHaveBeenCalled();
    expect(d.sendError).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledOnce();
  });

  it("F2: emits one correlated ERROR and calls sink", () => {
    const d = deps();
    const r = routeFrame(JSON.stringify(env({ payload: { nope: true } })), d);
    expect(r).toBe("f2");
    expect(d.malformed).not.toHaveBeenCalled();
    expect(d.sink.fail).toHaveBeenCalledWith("c1", expect.any(String));
    expect(d.sendError).toHaveBeenCalledOnce();
    const err = d.sendError.mock.calls[0]![0];
    expect(err.type).toBe("ERROR");
    expect(err.recipient).toBe("s");
    expect(err.correlationId).toBe("c1");
  });

  it("valid frame routes through", () => {
    const d = deps();
    const r = routeFrame(JSON.stringify(env()), d);
    expect(r).toBe("valid");
    expect(d.malformed).not.toHaveBeenCalled();
    expect(d.sendError).not.toHaveBeenCalled();
    expect(d.sink.fail).not.toHaveBeenCalled();
  });
});
