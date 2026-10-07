/**
 * Supervisor policy: protocol-fault stops, crash reassignment, global-budget
 * finalization, and contradiction follow-up. Semantic decomposition stays with
 * the supervisor model.
 */
import type { ControlPlane } from "../control/control-plane";
import type { WorkOrder } from "../runtime/work-order-manager";
import type { Reconciliation } from "./reconciliation";
import { finalize, type Finalization, type FinalReport } from "./finalization";

export interface SupervisorDeps {
  controlPlane: ControlPlane;
  reconciliation: Reconciliation;
  shouldStopOnFault: (agentId: string, count: number) => boolean;
  detectContradiction?: (reports: FinalReport[]) => boolean;
  onContradiction?: (reports: FinalReport[]) => void;
}

/**
 * Supervisor policy: owns protocol-fault stop decisions, crash reassignment,
 * global-budget finalization, contradiction follow-up, and final outcome.
 * Semantic decomposition/DoD evaluation stay with the supervisor model.
 */
export class Supervisor {
  constructor(private readonly deps: SupervisorDeps) {}

  onProtocolFault(agentId: string, count: number): boolean {
    if (this.deps.shouldStopOnFault(agentId, count)) {
      this.deps.controlPlane.stopAgent(agentId, "protocol fault");
      return true;
    }
    return false;
  }

  reassign(workOrder: WorkOrder, toAgentId: string): boolean {
    return this.deps.controlPlane.dispatchWork(toAgentId, workOrder);
  }

  onGlobalBudget(): void {
    this.deps.controlPlane.stopAll("global budget");
  }

  finalize(dodSatisfied: boolean): Finalization {
    return finalize(this.deps.reconciliation, dodSatisfied);
  }

  reconcile(): boolean {
    if (!this.deps.detectContradiction || !this.deps.onContradiction) return false;
    const reports = this.collectReports();
    if (this.deps.detectContradiction(reports)) {
      this.deps.onContradiction(reports);
      return true;
    }
    return false;
  }

  private collectReports(): FinalReport[] {
    return [...this.deps.reconciliation.reports().values()].map((env) => ({
      agentId: (env.payload as { agentId: string }).agentId,
      report: (env.payload as { report: string }).report,
    }));
  }
}
