/**
 * Feedback-workshop task orchestrator.
 * Orchestrates the full flow:
 * 1. Load prior task runs → DataManifest
 * 2. Dispatch 3 worker agents (cost-auditor, spec-finder, friction-detector)
 * 3. Collect findings from workers
 * 4. Optionally dispatch reviewer agent for ground-checking
 * 5. Finalize to findings-summary.md
 */
import { resolve } from "node:path";
import type { SessionConfig } from "../contracts/session-schema";
import { dispatchFeedbackWorkers } from "./dispatch-feedback-workers";
import { finalizeFeedbackWorkshop } from "./feedback-workshop-finalization";
import { loadFeedbackWorkshopArtifacts } from "./load-prior-runs";

export interface OrchestratorResult {
  status: "success" | "partial" | "failed";
  summary_path: string;
  workers_completed: number;
  reviewer_completed: boolean;
  total_findings: number;
  error?: string;
}

/**
 * Execute the feedback-workshop task orchestration.
 * @param config SessionConfig with role="feedback-workshop"
 * @param taskDir Base directory containing input task runs (e.g., "mypi-tasks")
 * @param outputDir Directory to write findings-summary.md (e.g., "run-details")
 * @returns OrchestratorResult with status and summary path
 */
export async function feedbackWorkshopOrchestrator(
  config: SessionConfig,
  taskDir: string,
  outputDir: string,
): Promise<OrchestratorResult> {
  try {
    // Step 1: Load prior task runs
    const manifest = await loadFeedbackWorkshopArtifacts(config, taskDir);

    // Step 2: Dispatch 3 worker agents in parallel
    // (In Phase 4, this uses mocks; Phase 5+ will use real subagent() dispatch)
    const workerResults = await dispatchFeedbackWorkers(manifest, config);

    // Step 3: Count completed workers
    const costFindings = workerResults.cost_auditor_report.findings?.length ?? 0;
    const specFindings = workerResults.spec_finder_report.findings?.length ?? 0;
    const frictionFindings = workerResults.friction_detector_report.findings?.length ?? 0;
    const workersCompleted = 3; // All 3 workers complete even with 0 findings

    // Step 4: Optionally dispatch reviewer
    // For MVP, reviewer is optional (Phase 3 adds the prompt, Phase 4 adds dispatch)
    const reviewerCompleted = (workerResults.reviewer_report?.validations?.length ?? 0) > 0;

    // Step 5: Finalize to findings-summary.md
    // TODO Phase 5: Write summaryMarkdown to disk via file system
    const _summaryMarkdown = finalizeFeedbackWorkshop(workerResults);
    const summaryPath = resolve(outputDir, "findings-summary.md");
    const totalFindings = costFindings + specFindings + frictionFindings;

    return {
      status: totalFindings > 0 ? "success" : "partial",
      summary_path: summaryPath,
      workers_completed: workersCompleted,
      reviewer_completed: reviewerCompleted,
      total_findings: totalFindings,
    };
  } catch (error) {
    return {
      status: "failed",
      summary_path: "",
      workers_completed: 0,
      reviewer_completed: false,
      total_findings: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
