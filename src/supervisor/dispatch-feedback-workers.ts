/**
 * Dispatch feedback-task worker agents (cost-auditor, spec-finder, friction-detector).
 * All agents receive pre-loaded artifacts and system prompts suggesting focus areas.
 * Collects findings with mandatory reference + reasoning.
 */
import type { DataManifest } from "./load-prior-runs";
import type { SessionConfig } from "../contracts/session-schema";

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

export interface FeedbackWorkerResult {
  cost_auditor_report: AgentReport;
  spec_finder_report: AgentReport;
  friction_detector_report: AgentReport;
}

/**
 * Build system prompt for cost-auditor with pre-loaded data.
 */
async function buildCostAuditorPrompt(
  manifest: DataManifest,
  _config: SessionConfig,
): Promise<string> {
  return `You are a Cost Anomaly Detector. Analyze prior task runs to identify spending patterns and anomalies.

## Instructions
- Analyze the provided data below carefully
- Focus on scorecard.json for cost and token metrics, but also read final.md, findings.md, and conversation.jsonl
- Every verdict MUST include: specific reference [artifact/line], and reasoning why that evidence supports your verdict
- Rate severity (HIGH/MEDIUM/LOW) and confidence (HIGH/MEDIUM/LOW) for each finding
- If you disagree with another agent or spot an issue they missed, cite evidence

## Data Manifest
${JSON.stringify(manifest, null, 2)}

## Task Analysis
Provide findings about cost anomalies. Format each as JSON with verdict, severity, reference, reasoning, confidence.

Example:
{
  "verdict": "Task X spent 3x more than peers",
  "severity": "HIGH",
  "reference": "task-1/scorecard.json: totalCostUsd 3.00 vs task-2/scorecard.json: totalCostUsd 1.00",
  "reasoning": "Cost difference is significant and correlates with neither output quality nor task complexity",
  "confidence": "HIGH"
}

Provide all findings as JSON array. Include summary at end.`;
}

/**
 * Build system prompt for spec-finder with pre-loaded data.
 */
async function buildSpecFinderPrompt(
  manifest: DataManifest,
  _config: SessionConfig,
): Promise<string> {
  return `You are a Spec Ambiguity Finder. Analyze prior task runs to identify vague, incomplete, or contradictory success criteria.

## Instructions
- Analyze the provided data below carefully
- Focus on the analyze block (success_criterion field), but also read final.md, findings.md, and conversation.jsonl
- Every verdict MUST include: specific reference [artifact/line], and reasoning why that evidence supports your verdict
- Rate severity (HIGH/MEDIUM/LOW) and confidence (HIGH/MEDIUM/LOW) for each finding
- Look for: vague terms, missing edge cases, contradictions between criterion and actual output
- If you spot issues other agents missed, cite evidence

## Data Manifest
${JSON.stringify(manifest, null, 2)}

## Task Analysis
Provide findings about specification ambiguity. Format each as JSON with verdict, severity, reference, reasoning, confidence.

Example:
{
  "verdict": "Success criterion 'output should be good' is too vague",
  "severity": "HIGH",
  "reference": "analyze block: success_criterion field, also task-1/conversation.jsonl lines 45-120 show agent asking for clarification 8x",
  "reasoning": "Criterion lacks objective acceptance criteria. Agent confusion correlates with communication friction.",
  "confidence": "HIGH"
}

Provide all findings as JSON array. Include summary at end.`;
}

/**
 * Build system prompt for friction-detector with pre-loaded data.
 */
async function buildFrictionDetectorPrompt(
  manifest: DataManifest,
  _config: SessionConfig,
): Promise<string> {
  return `You are a UX Friction Detector. Analyze prior task runs to identify friction in prompts, task design, or agent-human interaction.

## Instructions
- Analyze the provided data below carefully
- Focus on conversation.jsonl to detect communication friction, but also read final.md, findings.md, and scorecard.json
- Every verdict MUST include: specific reference [artifact/line], and reasoning why that evidence supports your verdict
- Rate severity (HIGH/MEDIUM/LOW) and confidence (HIGH/MEDIUM/LOW) for each finding
- Look for: repeated clarifications, confusion about requirements, unclear expectations, agent struggling
- If you disagree with other agents or spot issues they missed, cite evidence

## Data Manifest
${JSON.stringify(manifest, null, 2)}

## Task Analysis
Provide findings about UX friction in prompts or agent interaction. Format each as JSON with verdict, severity, reference, reasoning, confidence.

Example:
{
  "verdict": "Agent asked for clarification 8 times due to unclear prompt",
  "severity": "HIGH",
  "reference": "task-1/conversation.jsonl lines 45-120: agent says 'I don't understand', 'what do you mean', repeated 8x",
  "reasoning": "Repeated clarification requests indicate prompt was ambiguous. Cost wasted on communication instead of productive work.",
  "confidence": "HIGH",
  "supports_finding": "spec-finder's vagueness finding"
}

Provide all findings as JSON array. Include summary at end.`;
}

/**
 * Dispatch 3 feedback workers in parallel.
 * All agents receive all artifacts pre-loaded.
 * Returns collected findings with enforced reference + reasoning.
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

  // For MVP: return mock responses that follow schema
  // Phase 3 (#81-#85) will implement real agents with proper system prompts
  await buildCostAuditorPrompt(manifest, config);
  await buildSpecFinderPrompt(manifest, config);
  await buildFrictionDetectorPrompt(manifest, config);

  // Mock agent responses (validates schema compliance)
  const costAuditorReport: AgentReport = {
    agent: "cost-auditor",
    findings: [
      {
        verdict: "Task 1 shows higher cost than Task 2",
        severity: "MEDIUM",
        reference: "task-1/scorecard.json vs task-2/scorecard.json (totalCostUsd field)",
        reasoning: "Cost difference detected. Validate if justified by output complexity.",
        confidence: "HIGH",
      },
    ],
    summary: "Found 1 cost differential finding. Requires validation against output quality.",
  };

  const specFinderReport: AgentReport = {
    agent: "spec-finder",
    findings: [
      {
        verdict: "Success criterion lacks objective acceptance criteria",
        severity: "MEDIUM",
        reference: "analyze block: success_criterion field",
        reasoning: "Criterion lacks edge cases or objective metrics.",
        confidence: "MEDIUM",
      },
    ],
    summary: "Found 1 specification ambiguity. Consider adding acceptance criteria.",
  };

  const frictionDetectorReport: AgentReport = {
    agent: "friction-detector",
    findings: [],
    summary: "No significant UX friction detected in this sample.",
  };

  return {
    cost_auditor_report: costAuditorReport,
    spec_finder_report: specFinderReport,
    friction_detector_report: frictionDetectorReport,
  };
}
