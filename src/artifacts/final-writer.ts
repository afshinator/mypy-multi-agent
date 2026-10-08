/**
 * Renders the terminal artifacts: final.md (YAML frontmatter + cost breakdown +
 * the supervisor's decision record) and findings.md (the raw per-peer reports,
 * unedited). Called by Runtime.finalize and abortSession.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finalization } from "../supervisor/finalization";

const fmtCost = (n: number): number => Math.round(n * 10000) / 10000;
const fmtTokens = (n: number): number => Math.round(n);

export class FinalWriter {
  constructor(private readonly dir: string) {}

  async write(f: Finalization): Promise<void> {
    const frontmatter = `---\nstatus: ${f.outcome}\nexit_code: ${f.exitCode}\n${this.costs(f)}\n---\n`;
    // final.md is the decision record; the raw peer reports live in findings.md
    // so the outcome stays readable and the reports stay inspectable unedited.
    const decision = f.decision?.trim() || "_(not recorded — see findings.md)_";
    const body = `\n## Decision\n\n${decision}\n\n## Peer findings\n\nRaw per-peer reports: \`findings.md\`.\n`;
    await writeFile(join(this.dir, "final.md"), frontmatter + body);
    await writeFile(join(this.dir, "findings.md"), this.findings(f));
  }

  private findings(f: Finalization): string {
    const header = "# Findings\n\nRaw per-peer FINAL_REPORTs, unedited.\n";
    if (f.reports.length === 0) return `${header}\n_(none)_\n`;
    return `${header}\n${f.reports.map((r) => `## ${r.agentId}\n\n${r.report}`).join("\n\n")}\n`;
  }

  private costs(f: Finalization): string {
    if (!f.costs) return "";
    const c = f.costs;
    const agents = c.agents
      .map((a) => `  - name: ${a.name}\n    cost_usd: ${fmtCost(a.costUsd)}\n    tokens: ${fmtTokens(a.tokens)}`)
      .join("\n");
    return [
      `total_cost_usd: ${fmtCost(c.totalCostUsd)}`,
      `total_tokens: ${fmtTokens(c.totalTokens)}`,
      `supervisor_cost_usd: ${fmtCost(c.supervisorCostUsd)}`,
      `supervisor_tokens: ${fmtTokens(c.supervisorTokens)}`,
      "agents:",
      agents,
    ].join("\n");
  }
}
