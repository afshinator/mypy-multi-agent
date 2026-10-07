/**
 * Captures each peer's FINAL_REPORT exactly once for reconciliation.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";

export class Reconciliation {
  private finalReports = new Map<string, A2AEnvelope>();

  captureFinalReport(envelope: A2AEnvelope): boolean {
    const agentId = (envelope.payload as { agentId: string }).agentId;
    // Latest-wins: a later section's report overwrites an earlier one so
    // collect_reports and final.md never surface stale first-section content.
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
