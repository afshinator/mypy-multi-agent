/**
 * Captures each peer's FINAL_REPORT exactly once for reconciliation.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";

/** Captures each peer's FINAL_REPORT exactly once for reconciliation. */
export class Reconciliation {
  private finalReports = new Map<string, A2AEnvelope>();

  captureFinalReport(envelope: A2AEnvelope): boolean {
    const agentId = (envelope.payload as { agentId: string }).agentId;
    if (this.finalReports.has(agentId)) return false;
    this.finalReports.set(agentId, envelope);
    return true;
  }

  reports(): Map<string, A2AEnvelope> {
    return this.finalReports;
  }

  hasReport(agentId: string): boolean {
    return this.finalReports.has(agentId);
  }

  reportCount(): number {
    return this.finalReports.size;
  }
}
