import { describe, expect, it, vi } from "vitest";
import { Supervisor, type SupervisorDeps } from "../../src/supervisor/supervisor";
import { Reconciliation } from "../../src/supervisor/reconciliation";
import { ControlPlane } from "../../src/control/control-plane";
import { SessionState } from "../../src/control/session-state";
import { EXIT } from "../../src/runtime/exit";
import type { WorkOrder } from "../../src/runtime/work-order-manager";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

const wo: WorkOrder = { taskId: "t1", action: "a", contextFiles: [], constraints: [], localDoD: "d" };

const report = (agentId: string, text: string): A2AEnvelope => ({
  id: `r-${agentId}`,
  timestamp: 0,
  sender: agentId,
  recipient: "supervisor",
  type: "FINAL_REPORT",
  payload: { agentId, report: text },
});

function makeSupervisor(over: Partial<SupervisorDeps> = {}) {
  const sink = { emit: vi.fn() };
  const session = new SessionState();
  const controlPlane = new ControlPlane(session, sink);
  const reconciliation = new Reconciliation();
  const s = new Supervisor({ controlPlane, reconciliation, shouldStopOnFault: () => true, ...over });
  return { sink, session, controlPlane, reconciliation, supervisor: s };
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

  it("peer crash reassigns work to another peer", () => {
    const { sink, supervisor } = makeSupervisor();
    expect(supervisor.reassign(wo, "b")).toBe(true);
    const e = sink.emit.mock.calls[0]![0] as A2AEnvelope;
    expect(e.type).toBe("WORK_ORDER");
    expect(e.recipient).toBe("b");
  });

  it("global budget triggers finalizing", () => {
    const { session, supervisor } = makeSupervisor();
    supervisor.onGlobalBudget();
    expect(session.isFinalizing).toBe(true);
  });

  it("finalize reflects DoD into exit code", () => {
    const { reconciliation, supervisor } = makeSupervisor();
    reconciliation.captureFinalReport(report("a", "done"));
    expect(supervisor.finalize(true).exitCode).toBe(EXIT.SUCCESS);
    expect(supervisor.finalize(false).exitCode).toBe(EXIT.FAILURE);
  });

  it("contradictory results trigger follow-up", () => {
    const followUps: unknown[] = [];
    const { reconciliation, supervisor } = makeSupervisor({
      detectContradiction: () => true,
      onContradiction: (reports) => followUps.push(reports),
    });
    reconciliation.captureFinalReport(report("a", "x"));
    reconciliation.captureFinalReport(report("b", "not x"));
    expect(supervisor.reconcile()).toBe(true);
    expect(followUps).toHaveLength(1);
  });
});
