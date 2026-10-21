/**
 * Dispatch feedback-task worker agents (cost-auditor, spec-finder, friction-detector).
 * All agents receive pre-loaded artifacts and refined system prompts.
 * Collects findings with mandatory reference + reasoning.
 */

import type { SessionConfig } from "../contracts/session-schema";
import { buildCostAuditorPrompt } from "./cost-auditor-prompt";
import { buildFrictionDetectorPrompt } from "./friction-detector-prompt";
import type { DataManifest } from "./load-prior-runs";
import { buildSpecFinderPrompt } from "./spec-finder-prompt";

export interface Finding {
  verdict: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  reference: string;
  reasoning: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  supports_finding?: string;
  refutes_finding?: string;
}

export interface AgentReport {
  agent: string;
  findings: Finding[];
  summary: string;
}

export interface ReviewerValidation {
  finding_index: number;
  agent: "cost-auditor" | "spec-finder" | "friction-detector";
  verdict: "support" | "refute" | "support_with_caveats";
  severity_validated: "HIGH" | "MEDIUM" | "LOW";
  reasoning: string;
  evidence: string;
  refinements?: string;
}

export interface ReviewerReport {
  agent: "reviewer";
  validations: ReviewerValidation[];
  summary: string;
}

export interface FeedbackWorkerResult {
  cost_auditor_report: AgentReport;
  spec_finder_report: AgentReport;
  friction_detector_report: AgentReport;
  reviewer_report?: ReviewerReport;
}

/**
 * Dispatch 3 feedback workers in parallel.
 * All agents receive all artifacts pre-loaded via system prompts.
 * Returns collected findings with enforced reference + reasoning.
 *
 * MVP: Uses real prompt builders but mocks agent responses.
 * Phase 3 (#84+): Replace mocks with real subagent({ tasks: [...] }) calls.
 */
export async function dispatchFeedbackWorkers(
  manifest: DataManifest,
  config: SessionConfig,
): Promise<FeedbackWorkerResult> {
  // Validate manifest
  if (!manifest) {
    throw new Error("manifest is required");
  }
  if (!manifest.tasks || manifest.tasks.length === 0) {
    throw new Error("manifest must contain at least one task");
  }

  // Build system prompts for each agent (verifies they work)
  // TODO Phase 3: Replace mock responses with real subagent({ tasks: [...] }) using these prompts
  const _costAuditorPrompt = buildCostAuditorPrompt(manifest);
  const _specFinderPrompt = buildSpecFinderPrompt(manifest, config);
  const _frictionDetectorPrompt = buildFrictionDetectorPrompt(manifest);

  // MVP: Mock responses that demonstrate prompt usage
  // Each finding references actual data from the manifest to show prompts were used

  const costAuditorReport: AgentReport = {
    agent: "cost-auditor",
    findings:
      manifest.tasks.length > 1
        ? [
            {
              verdict: `Task ${manifest.tasks[0]?.task_id} cost differential vs peers`,
              severity:
                manifest.tasks[0]?.scorecard_frontmatter?.cost &&
                manifest.tasks[1]?.scorecard_frontmatter?.cost &&
                manifest.tasks[0].scorecard_frontmatter.cost >
                  manifest.tasks[1].scorecard_frontmatter.cost * 2
                  ? "HIGH"
                  : "MEDIUM",
              reference: `scorecard.json: task-${manifest.tasks[0]?.task_id} cost=$${manifest.tasks[0]?.scorecard_frontmatter?.cost ?? "N/A"}`,
              reasoning:
                "Cost difference detected in scorecard. Validate if justified by output scope.",
              confidence: "HIGH",
            },
          ]
        : [],
    summary: `Analyzed ${manifest.tasks.length} task(s). Found cost differential pattern(s).`,
  };

  const specFinderReport: AgentReport = {
    agent: "spec-finder",
    findings: [
      {
        verdict: "Success criterion analysis",
        severity: "MEDIUM",
        reference: `analyze block: success_criterion = "${config.analyze?.success_criterion ?? "N/A"}"`,
        reasoning: "Criterion stated. Checking for clarity and measurability.",
        confidence: "MEDIUM",
      },
    ],
    summary: "Reviewed success criteria. See findings for ambiguity assessment.",
  };

  const frictionDetectorReport: AgentReport = {
    agent: "friction-detector",
    findings: manifest.tasks.some((t) => t.artifacts?.conversation_jsonl?.available)
      ? [
          {
            verdict: "Communication pattern analysis",
            severity: "LOW",
            reference: `conversation.jsonl available for ${manifest.tasks.filter((t) => t.artifacts?.conversation_jsonl?.available).length} task(s)`,
            reasoning:
              "Conversation data available for friction detection. No obvious loops detected in sample.",
            confidence: "MEDIUM",
          },
        ]
      : [],
    summary: "Analyzed conversation patterns. No critical UX friction detected.",
  };

  return {
    cost_auditor_report: costAuditorReport,
    spec_finder_report: specFinderReport,
    friction_detector_report: frictionDetectorReport,
  };
}
