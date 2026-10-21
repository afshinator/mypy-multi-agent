/**
 * Finalization for the analysis task type.
 *
 * Assembles the post-mortem from the four prose reports. It does not parse,
 * score or rewrite them: the analysts' own words carry the findings, and the
 * reviewer's words carry the challenge to them. What this adds is the frame —
 * what was examined, what evidence existed, and what the reader is supposed to
 * do with the result.
 */
import type { AnalysisReports, AnalystId } from "./analysis-types";

const ORDER: AnalystId[] = ["cost", "spec", "friction"];

const HEADING: Record<AnalystId, string> = {
  cost: "Cost and time",
  spec: "Task definition",
  friction: "Interaction",
};

export function finalizeAnalysis(reports: AnalysisReports): string {
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push("# Post-mortem", "");

  push("## What was examined", "");
  for (const t of reports.targets) {
    push(`- **${t.id}** — \`${t.run_details_dir}\``);
    push(`  - present: ${t.artifacts.map((a) => a.name).join(", ")}`);
    if (t.missing.length > 0) {
      push(`  - absent: ${t.missing.join(", ")}`);
    }
  }
  push("");

  push("## Stated success criterion", "");
  push(reports.success_criterion, "");

  if (reports.failures && reports.failures.length > 0) {
    push("## Analysts that did not report", "");
    push(
      "These lenses are missing from the review below. A post-mortem with a",
      "silent analyst is weaker than one with an empty report.",
      "",
    );
    for (const f of reports.failures) {
      push(`- **${HEADING[f.analyst]}** — ${f.error}`);
    }
    push("");
  }

  const byAnalyst = new Map(reports.analysts.map((r) => [r.analyst, r.report]));

  push("## Findings by lens", "");
  for (const id of ORDER) {
    const body = byAnalyst.get(id);
    push(`### ${HEADING[id]}`, "");
    push(body?.trim() ? body.trim() : "_No report._", "");
  }

  push("## Review", "");
  push(
    reports.reviewer?.report.trim()
      ? reports.reviewer.report.trim()
      : "_No reviewer report. The findings above are unreviewed: treat each claim as unverified._",
    "",
  );

  push("## How to use this document", "");
  push(
    "Findings are addressed to whoever maintains the task template that",
    "produced these runs. Each finding names the evidence it rests on and the",
    "reaction it proposes; reactions may point at a prompt in the template yaml,",
    "a config field, a model, or the shape of the work order.",
    "",
    "Before acting on a finding:",
    "",
    "1. Open the cited artifact and confirm the observation. An unreviewed claim",
    "   is a hypothesis, and the reviewer above may already have refuted it.",
    '2. Decide whether the cause is ours. "The provider degrades after 40k',
    '   tokens" is not a defect in our prompt, but capping the work order is',
    "   still our decision.",
    "3. Change one thing at a time, so the next post-mortem can attribute the",
    "   effect.",
    "",
    "Re-run this task against the same runs afterwards: the difference between",
    "the two reports is the measurement.",
  );

  return lines.join("\n");
}
