/**
 * Supervisor policy: protocol-fault stops. Decomposition, steering, and
 * reconciliation decisions stay with the supervisor model.
 */
import type { ControlPlane } from "../control/control-plane";

export interface SupervisorDeps {
  controlPlane: ControlPlane;
  shouldStopOnFault: (agentId: string, count: number) => boolean;
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
}
