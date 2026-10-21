/**
 * Real subagent dispatch for analysis workers.
 * Spawns 3 agents via subagent({ tasks: [...] }) in parallel.
 * Each agent gets its system prompt + manifest data.
 * Parses JSON outputs and validates Finding schema.
 *
 * Phase 4: Uses mocks + prompts for testing
 * Phase 5+: Real subagent() execution with output parsing
 */
import type { SessionConfig } from "../contracts/session-schema";
import { buildCostAuditorPrompt } from "./cost-auditor-prompt";
import {
  dispatchFeedbackWorkers as dispatchMockWorkers,
  type FeedbackWorkerResult,
} from "./dispatch-feedback-workers";
import { buildFrictionDetectorPrompt } from "./friction-detector-prompt";
import type { DataManifest } from "./load-prior-runs";
import { buildSpecFinderPrompt } from "./spec-finder-prompt";

/**
 * Dispatch real subagent workers.
 * Phase 5 TODO: Replace mock dispatch with real subagent() calls.
 * For now, this wraps the mock dispatch but with real prompts verified.
 */
export async function dispatchRealWorkers(
  manifest: DataManifest,
  config: SessionConfig,
): Promise<FeedbackWorkerResult> {
  // Verify prompts work (they will be used in Phase 5 with real subagent dispatch)
  const costAuditorPrompt = buildCostAuditorPrompt(manifest);
  const specFinderPrompt = buildSpecFinderPrompt(manifest, config);
  const frictionDetectorPrompt = buildFrictionDetectorPrompt(manifest);

  if (!costAuditorPrompt || !specFinderPrompt || !frictionDetectorPrompt) {
    throw new Error("Failed to build system prompts");
  }

  // Phase 5: TODO Replace with real subagent dispatch
  // const workerResults = await subagent({
  //   tasks: [
  //     {
  //       id: "cost-auditor",
  //       agent: "cost-auditor",
  //       task: "Analyze cost data from scorecard",
  //       prompt: costAuditorPrompt,
  //       ...
  //     },
  //     // ... spec-finder, friction-detector
  //   ],
  //   concurrency: 3,
  // });
  // Parse JSON outputs and validate schema...

  // For now, use mock dispatch with real prompts verified
  const result = await dispatchMockWorkers(manifest, config);

  // Validate all findings have reference + reasoning
  const allFindings = [
    ...result.cost_auditor_report.findings,
    ...result.spec_finder_report.findings,
    ...result.friction_detector_report.findings,
  ];

  for (const finding of allFindings) {
    if (!finding.reference || finding.reference.length === 0) {
      throw new Error(`Finding missing reference: ${finding.verdict}`);
    }
    if (!finding.reasoning || finding.reasoning.length === 0) {
      throw new Error(`Finding missing reasoning: ${finding.verdict}`);
    }
  }

  return result;
}
