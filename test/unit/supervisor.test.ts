/**
 * Unit tests for the supervisor module.
 */
import { describe, expect, it, vi } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { ControlPlane } from "../../src/control/control-plane";
import { SessionState } from "../../src/control/session-state";
import { Supervisor, type SupervisorDeps } from "../../src/supervisor/supervisor";

function makeSupervisor(over: Partial<SupervisorDeps> = {}) {
  const sink = { emit: vi.fn() };
  const controlPlane = new ControlPlane(new SessionState(), sink);
  const s = new Supervisor({ controlPlane, shouldStopOnFault: () => true, ...over });
  return { sink, controlPlane, supervisor: s };
}

describe("Supervisor", () => {
  it("protocol fault causes supervisor-directed stop", () => {
    const { sink, supervisor } = makeSupervisor();
    expect(supervisor.onProtocolFault("a1", 5)).toBe(true);
    expect(sink.emit).toHaveBeenCalledOnce();
    expect((sink.emit.mock.calls[0]![0] as A2AEnvelope).type).toBe("STOP_AGENT");
  });

  it("protocol fault ignored when policy says no", () => {
    const { sink, supervisor } = makeSupervisor({ shouldStopOnFault: () => false });
    expect(supervisor.onProtocolFault("a1", 5)).toBe(false);
    expect(sink.emit).not.toHaveBeenCalled();
  });
});
