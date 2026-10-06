import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finalization } from "../supervisor/finalization";

/** Writes final.md with YAML frontmatter and per-agent report sections. */
export class FinalWriter {
  constructor(private readonly dir: string) {}

  async write(f: Finalization): Promise<void> {
    const frontmatter = `---\nstatus: ${f.outcome}\nexit_code: ${f.exitCode}\n---\n`;
    const body = f.reports.map((r) => `## ${r.agentId}\n${r.report}`).join("\n\n");
    await writeFile(join(this.dir, "final.md"), frontmatter + body + "\n");
  }
}
