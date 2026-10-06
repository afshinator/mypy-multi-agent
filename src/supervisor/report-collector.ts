import type { Reconciliation } from "./reconciliation";

/** Format captured FINAL_REPORTs as text for the supervisor's context. */
export function collectReports(reconciliation: Reconciliation): string {
  const reports = [...reconciliation.reports().values()].map((env) => {
    const p = env.payload as { agentId: string; report: string };
    return `## ${p.agentId}\n${p.report}`;
  });
  return reports.join("\n\n");
}
