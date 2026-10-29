/**
 * Formats captured FINAL_REPORTs for the supervisor's own context.
 *
 * The supervisor reads no files while it works, so it used to receive every
 * report verbatim and end up the largest token consumer in the run — 52.4% and
 * 58.2% of tokens in two post-mortem-03 targets (rec 12). Each report is written
 * to its own file instead, and the supervisor gets the path plus a bounded head:
 * the full text is one `read` away, and `findings.md` keeps the run's record.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Reconciliation } from "./reconciliation";

/** Characters of each report handed to the supervisor; the rest is on disk. */
const HEAD_CHARS = 1200;

/** Agent ids reach a filesystem path, so keep only characters that cannot climb. */
const slug = (agentId: string): string => agentId.replace(/[^A-Za-z0-9_-]/g, "_");

export async function collectReports(
  reconciliation: Reconciliation,
  reportsDir: string,
): Promise<string> {
  const reports = [...reconciliation.reports().values()].map((env) => {
    const p = env.payload as { agentId: string; report: string };
    return { agentId: p.agentId, report: p.report };
  });
  if (reports.length === 0) return "";
  await mkdir(reportsDir, { recursive: true });
  const sections: string[] = [];
  for (const { agentId, report } of reports) {
    const file = join(reportsDir, `${slug(agentId)}.md`);
    await writeFile(file, report.endsWith("\n") ? report : `${report}\n`);
    const lines = report.split("\n").length;
    const head = report.slice(0, HEAD_CHARS);
    const more = report.length > HEAD_CHARS ? "\n… truncated — `read` the file for the rest" : "";
    sections.push(`## ${agentId}\n${file} (${lines} lines)\n\n${head}${more}`);
  }
  return sections.join("\n\n");
}
