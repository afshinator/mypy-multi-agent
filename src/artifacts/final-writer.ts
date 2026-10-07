/**
 * Renders final.md (YAML frontmatter, per-agent sections, cost breakdown).
 * Terminal artifact writer, called by Runtime.finalize and abortSession.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finalization } from "../supervisor/finalization";

const fmtCost = (n: number): number => Math.round(n * 10000) / 10000;
const fmtTokens = (n: number): number => Math.round(n);

/** Writes final.md with YAML frontmatter and per-agent report sections. */
export class FinalWriter {
  constructor(private readonly dir: string) {}

  async write(f: Finalization): Promise<void> {
    const frontmatter = `---\nstatus: ${f.outcome}\nexit_code: ${f.exitCode}\n${this.costs(f)}\n---\n`;
    const body = f.reports.map((r) => `## ${r.agentId}\n${r.report}`).join("\n\n");
    await writeFile(join(this.dir, "final.md"), frontmatter + body + "\n");
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
