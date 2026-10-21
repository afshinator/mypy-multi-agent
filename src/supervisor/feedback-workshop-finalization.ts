/**
 * Finalization logic for feedback-workshop task type.
 * Collects findings from worker agents and reviewer validations.
 * Outputs findings-summary.md (recommendations document for human review).
 */
import type { FeedbackWorkerResult } from "./dispatch-feedback-workers";

/**
 * Finalize feedback-workshop results into findings-summary.md format.
 * All findings are traced with evidence citations and reviewer ground-checks.
 */
export function finalizeFeedbackWorkshop(results: FeedbackWorkerResult): string {
  const lines: string[] = [];

  lines.push("# Feedback Workshop Findings Summary");
  lines.push("");
  lines.push("This document contains template improvement recommendations based on analysis");
  lines.push("of prior task runs.");
  lines.push("");

  // Overall stats
  const totalFindings =
    (results.cost_auditor_report.findings?.length ?? 0) +
    (results.spec_finder_report.findings?.length ?? 0) +
    (results.friction_detector_report.findings?.length ?? 0);

  const reviewerCount = results.reviewer_report?.validations?.length ?? 0;

  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Total Findings**: ${totalFindings}`);
  lines.push(`- **Reviewed**: ${reviewerCount}`);
  if (results.reviewer_report) {
    const supported = results.reviewer_report.validations.filter(
      (v) => v.verdict === "support",
    ).length;
    const refuted = results.reviewer_report.validations.filter(
      (v) => v.verdict === "refute",
    ).length;
    const caveats = results.reviewer_report.validations.filter(
      (v) => v.verdict === "support_with_caveats",
    ).length;
    lines.push(`- **Supported**: ${supported}`);
    lines.push(`- **Refuted**: ${refuted}`);
    lines.push(`- **With Caveats**: ${caveats}`);
  }
  lines.push("");

  // Cost Auditor section
  lines.push("## Cost Anomalies (Cost Auditor)");
  lines.push("");
  lines.push(`_${results.cost_auditor_report.summary}_`);
  lines.push("");

  if (results.cost_auditor_report.findings && results.cost_auditor_report.findings.length > 0) {
    for (const finding of results.cost_auditor_report.findings) {
      lines.push(`### ${finding.verdict}`);
      lines.push("");
      lines.push(`**Severity**: ${finding.severity} | **Confidence**: ${finding.confidence}`);
      lines.push("");
      lines.push(`**Reference**: ${finding.reference}`);
      lines.push("");
      lines.push(`**Reasoning**: ${finding.reasoning}`);
      lines.push("");

      // Add reviewer validation if present
      if (results.reviewer_report) {
        const validation = results.reviewer_report.validations.find(
          (v) => v.agent === "cost-auditor",
        );
        if (validation) {
          lines.push(`**Reviewer Validation**: ${validation.verdict.toUpperCase()}`);
          lines.push(`- Evidence: ${validation.evidence}`);
          if (validation.refinements) {
            lines.push(`- Refinements: ${validation.refinements}`);
          }
          lines.push("");
        }
      }
    }
  } else {
    lines.push("_No cost anomalies detected._");
    lines.push("");
  }

  // Spec Finder section
  lines.push("## Specification Clarity (Spec Finder)");
  lines.push("");
  lines.push(`_${results.spec_finder_report.summary}_`);
  lines.push("");

  if (results.spec_finder_report.findings && results.spec_finder_report.findings.length > 0) {
    for (const finding of results.spec_finder_report.findings) {
      lines.push(`### ${finding.verdict}`);
      lines.push("");
      lines.push(`**Severity**: ${finding.severity} | **Confidence**: ${finding.confidence}`);
      lines.push("");
      lines.push(`**Reference**: ${finding.reference}`);
      lines.push("");
      lines.push(`**Reasoning**: ${finding.reasoning}`);
      lines.push("");

      if (results.reviewer_report) {
        const validation = results.reviewer_report.validations.find(
          (v) => v.agent === "spec-finder",
        );
        if (validation) {
          lines.push(`**Reviewer Validation**: ${validation.verdict.toUpperCase()}`);
          lines.push(`- Evidence: ${validation.evidence}`);
          if (validation.refinements) {
            lines.push(`- Refinements: ${validation.refinements}`);
          }
          lines.push("");
        }
      }
    }
  } else {
    lines.push("_No spec clarity issues detected._");
    lines.push("");
  }

  // Friction Detector section
  lines.push("## Communication Friction (Friction Detector)");
  lines.push("");
  lines.push(`_${results.friction_detector_report.summary}_`);
  lines.push("");

  if (
    results.friction_detector_report.findings &&
    results.friction_detector_report.findings.length > 0
  ) {
    for (const finding of results.friction_detector_report.findings) {
      lines.push(`### ${finding.verdict}`);
      lines.push("");
      lines.push(`**Severity**: ${finding.severity} | **Confidence**: ${finding.confidence}`);
      lines.push("");
      lines.push(`**Reference**: ${finding.reference}`);
      lines.push("");
      lines.push(`**Reasoning**: ${finding.reasoning}`);
      lines.push("");

      if (results.reviewer_report) {
        const validation = results.reviewer_report.validations.find(
          (v) => v.agent === "friction-detector",
        );
        if (validation) {
          lines.push(`**Reviewer Validation**: ${validation.verdict.toUpperCase()}`);
          lines.push(`- Evidence: ${validation.evidence}`);
          if (validation.refinements) {
            lines.push(`- Refinements: ${validation.refinements}`);
          }
          lines.push("");
        }
      }
    }
  } else {
    lines.push("_No friction patterns detected._");
    lines.push("");
  }

  // Reviewer summary
  if (results.reviewer_report) {
    lines.push("## Reviewer Ground-Check Summary");
    lines.push("");
    lines.push(`_${results.reviewer_report.summary}_`);
    lines.push("");
  }

  lines.push("## Recommendations for Template Changes");
  lines.push("");
  lines.push("Based on the findings above, consider the following template improvements:");
  lines.push("");
  lines.push("1. **If Cost Anomalies**: Review cost drivers (model choice, token usage, retries)");
  lines.push(
    "2. **If Spec Clarity Issues**: Add success criteria templates with measurable outcomes",
  );
  lines.push(
    "3. **If Communication Friction**: Add example prompts or clarification request handlers",
  );
  lines.push("");

  lines.push("## How to Use This Report");
  lines.push("");
  lines.push("1. Review each finding and its reviewer validation");
  lines.push("2. Decide which recommendations to implement");
  lines.push("3. Update the template(s) accordingly");
  lines.push("4. Re-run feedback-workshop on new tasks to measure improvement");
  lines.push("");

  return lines.join("\n");
}
