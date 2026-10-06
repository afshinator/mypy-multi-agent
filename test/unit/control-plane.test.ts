import { describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../src/control/control-plane";
import { SessionState } from "../../src/control/session-state";
import type { WorkOrder } from "../../src/runtime/work-order-manager";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

const wo: WorkOrder = { taskId: "t1", action: "a", contextFiles: [], constraints: [], localDoD: "d" };

describe("ControlPlane", () => {
  it("stop one peer emits STOP_AGENT", () => {
    const sink = { emit: vi.fn() };
    const s = new SessionState();
    const cp = new ControlPlane(s, sink);
    cp.stopAgent("a1", "reason");
    expect(sink.emit).toHaveBeenCalledOnce();
    const e = sink.emit.mock.calls[0]![0] as A2AEnvelope;
    expect(e.type).toBe("STOP_AGENT");
    expect(e.recipient).toBe("a1");
    expect((e.payload as { agentId: string }).agentId).toBe("a1");
  });

  it("stop all enters FINALIZING and emits STOP_ALL", () => {
    const sink = { emit: vi.fn() };
    const s = new SessionState();
    const cp = new ControlPlane(s, sink);
    cp.stopAll();
    expect(s.isFinalizing).toBe(true);
    const e = sink.emit.mock.calls[0]![0] as A2AEnvelope;
    expect(e.type).toBe("STOP_ALL");
    expect(e.recipient).toBe("all");
  });

  it("kill all aborts and emits KILL_ALL", () => {
    const sink = { emit: vi.fn() };
    const s = new SessionState();
    const cp = new ControlPlane(s, sink);
    cp.killAll();
    expect(s.current).toBe("ABORTED");
    const e = sink.emit.mock.calls[0]![0] as A2AEnvelope;
    expect(e.type).toBe("KILL_ALL");
    expect(e.recipient).toBe("all");
  });

  it("rejects new work during FINALIZING", () => {
    const sink = { emit: vi.fn() };
    const s = new SessionState();
    s.enterFinalizing();
    const cp = new ControlPlane(s, sink);
    expect(cp.dispatchWork("a1", wo)).toBe(false);
    expect(sink.emit).not.toHaveBeenCalled();
  });

  it("dispatches work when ACTIVE", () => {
    const sink = { emit: vi.fn() };
    const cp = new ControlPlane(new SessionState(), sink);
    expect(cp.dispatchWork("a1", wo)).toBe(true);
    const e = sink.emit.mock.calls[0]![0] as A2AEnvelope;
    expect(e.type).toBe("WORK_ORDER");
    expect(e.recipient).toBe("a1");
  });

  it("mock peer exits on kill signal", () => {
    let exited = false;
    const sink = {
      emit: (e: A2AEnvelope) => {
        if (e.type === "KILL_ALL") exited = true;
      },
    };
    const cp = new ControlPlane(new SessionState(), sink);
    cp.killAll();
    expect(exited).toBe(true);
  });
});
