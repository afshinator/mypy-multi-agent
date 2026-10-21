/**
 * Reviewer agent system prompt builder.
 * Validates findings from 3 worker agents (cost-auditor, spec-finder, friction-detector)
 * with evidence citations and cross-references.
 *
 * Role: Ground-check all findings against real manifest data.
 * Output: Validation verdict for each finding (support/refute + evidence).
 */

import type { FeedbackWorkerResult } from "./dispatch-feedback-workers";
import type { DataManifest } from "./load-prior-runs";

/**
 * Build the reviewer system prompt.
 * Includes all worker findings, manifest data, and worked examples of validation logic.
 */
export function buildReviewerPrompt(
  manifest: DataManifest,
  workerResults: FeedbackWorkerResult,
): string {
  const manifestJson = JSON.stringify(manifest, null, 2);

  // Collect all findings from workers
  const allFindings = [
    ...workerResults.cost_auditor_report.findings,
    ...workerResults.spec_finder_report.findings,
    ...workerResults.friction_detector_report.findings,
  ];

  const findingsJson = allFindings
    .map(
      (f, i) =>
        `Finding ${i + 1}: ${f.verdict}
  Severity: ${f.severity} | Confidence: ${f.confidence}
  Reference: ${f.reference}
  Reasoning: ${f.reasoning}`,
    )
    .join("\n\n");

  return `You are a Reviewer Agent for the feedback-workshop task type.

Your role: Validate findings from 3 specialist agents (Cost Auditor, Spec Finder, Friction Detector).
Each finding must be ground-checked against the actual task run data.

GROUND-CHECK CRITERIA:
1. Reference is valid (points to a real artifact/line in the manifest)
2. Reasoning is sound (the evidence supports the verdict)
3. Severity is proportional (HIGH for blocking issues, MEDIUM for hampering, LOW for minor)
4. Confidence matches evidence quality (HIGH if clear, MEDIUM if pattern-based, LOW if inferred)

INPUT DATA:

MANIFEST (Task artifacts):
${manifestJson}

WORKER FINDINGS TO VALIDATE:

${findingsJson}

AGENT REPORTS SUMMARY:
- Cost Auditor: ${workerResults.cost_auditor_report.summary}
- Spec Finder: ${workerResults.spec_finder_report.summary}
- Friction Detector: ${workerResults.friction_detector_report.summary}

WORKED EXAMPLES:

Example 1: SUPPORT a finding
Finding: "Task cost is high ($500) vs peers (avg $150)"
  Reference: scorecard.json: cost=$500
  Reasoning: 3x above peer average
Validation: ✓ SUPPORT - scorecard data is verifiable, 3x is quantifiable, HIGH severity justified
  Evidence: scorecard.json shows exact cost, peer comparison is objective

Example 2: REFUTE a finding
Finding: "All turns were communication loops"
  Reference: conversation.jsonl (unspecified)
  Reasoning: Agent asked clarifications repeatedly
Validation: ✗ REFUTE - reference is vague (no line ranges), "all" is unsupported, only 3 of 12 turns were loops
  Counter-evidence: conversation.jsonl shows turns 1-3 productive, turns 4-6 loops, turns 7-12 productive

Example 3: SUPPORT with caveats
Finding: "Friction in specification conversation"
  Reference: conversation.jsonl lines 45-78
  Reasoning: Agent asked for clarification 3 times
Validation: ✓ SUPPORT WITH CAVEATS - reference is precise, friction pattern is real, but severity is MEDIUM not HIGH
  Refinement: The 3 clarifications were productive (agent understood after each), so MEDIUM is more accurate than HIGH

OUTPUT FORMAT:
For each finding, respond with:
{
  "finding_index": <number>,
  "agent": "<cost-auditor|spec-finder|friction-detector>",
  "verdict": "support" | "refute" | "support_with_caveats",
  "severity_validated": "<HIGH|MEDIUM|LOW>",
  "reasoning": "<why the finding is valid/invalid>",
  "evidence": "<specific artifact evidence>",
  "refinements": "<if support_with_caveats, state what changed>"
}

Your task: Validate EVERY finding. Be precise with references. Ground every verdict in the manifest.`;
}
