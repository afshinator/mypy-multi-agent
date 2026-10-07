/**
 * Supervisor policy: protocol-fault stops, crash reassignment, global-budget
 * finalization, and contradiction follow-up. Semantic decomposition stays with
 * the supervisor model.
 */
import type { ControlPlane } from "../control/control-plane";
import type { WorkOrder } from "../runtime/work-order-manager";
import type { Reconciliation } from "./reconciliation";
import { finalReports, finalize, type Finalization, type FinalReport } from "./finalization";

export interface SupervisorDeps {
  controlPlane: ControlPlane;
  reconciliation: Reconciliation;
  shouldStopOnFault: (agentId: string, count: number) => boolean;
  detectContradiction?: (reports: FinalReport[]) => boolean;
  onContradiction?: (reports: FinalReport[]) => void;
}

export class Supervisor {
  constructor(private readonly deps: SupervisorDeps) {}

  onProtocolFault(agentId: string, count: number): boolean {
    if (this.deps.shouldStopOnFault(agentId, count)) {
      this.deps.controlPlane.stopAgent(agentId, "protocol fault");
      return true;
    }
    return false;
  }

  // The methods below are the supervisor's policy API: exercised by the unit
  // tests and wired in as the runtime grows, so they are kept deliberately.
  // fallow-ignore-next-line unused-class-member
  reassign(workOrder: WorkOrder, toAgentId: string): boolean {
    return this.deps.controlPlane.dispatchWork(toAgentId, workOrder);
  }

  // fallow-ignore-next-line unused-class-member
  onGlobalBudget(): void {
    this.deps.controlPlane.stopAll("global budget");
  }

  // fallow-ignore-next-line unused-class-member
  finalize(dodSatisfied: boolean): Finalization {
    return finalize(this.deps.reconciliation, dodSatisfied);
  }

  // fallow-ignore-next-line unused-class-member
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
    return finalReports(this.deps.reconciliation);
  }
}
