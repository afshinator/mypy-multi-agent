/**
 * Write findings-summary.md to disk.
 * Called by orchestrator after finalization.
 * Persists the human-readable recommendations document.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { finalizeAnalysis } from "./analysis-finalization";
import type { FeedbackWorkerResult } from "./dispatch-feedback-workers";

export interface WriteSummaryResult {
  status: "success" | "failed";
  path: string;
  bytes_written?: number;
  error?: string;
}

/**
 * Write findings-summary.md to disk.
 * @param results FeedbackWorkerResult with findings from all agents
 * @param outputPath Full path where findings-summary.md should be written
 * @returns WriteSummaryResult with status and details
 */
export async function writeFindingsSummary(
  results: FeedbackWorkerResult,
  outputPath: string,
): Promise<WriteSummaryResult> {
  try {
    // Generate markdown
    const markdown = finalizeAnalysis(results);

    // Ensure output directory exists
    const outputDir = dirname(outputPath);
    mkdirSync(outputDir, { recursive: true });

    // Write to disk
    writeFileSync(outputPath, markdown, "utf-8");

    return {
      status: "success",
      path: outputPath,
      bytes_written: Buffer.byteLength(markdown, "utf-8"),
    };
  } catch (error) {
    return {
      status: "failed",
      path: outputPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
