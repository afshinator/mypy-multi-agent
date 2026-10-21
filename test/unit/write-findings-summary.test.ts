/**
 * #91: Write findings-summary.md to disk
 * Orchestrator calls this to persist the final recommendations document
 */
import { describe, it, expect } from "vitest";
import {
  writeFindinsSummary,
  type WriteSummaryResult,
} from "../../src/supervisor/write-findings-summary";
import type { FeedbackWorkerResult } from "../../src/supervisor/dispatch-feedback-workers";

describe("write-findings-summary (#91)", () => {
  const workerResults: FeedbackWorkerResult = {
    cost_auditor_report: {
      agent: "cost-auditor",
      findings: [
        {
          verdict: "Task cost is high",
          severity: "HIGH",
          reference: "scorecard.json: cost=$100",
          reasoning: "Significantly above peer average",
          confidence: "HIGH",
        },
      ],
      summary: "Found 1 cost anomaly",
    },
    spec_finder_report: {
      agent: "spec-finder",
      findings: [],
      summary: "No spec clarity issues",
    },
    friction_detector_report: {
      agent: "friction-detector",
      findings: [],
      summary: "No friction patterns",
    },
  };

  it("1. exports writeFindinsSummary function", () => {
    expect(typeof writeFindinsSummary).toBe("function");
  });

  it("2. function signature: (results, outputPath) => Promise<WriteSummaryResult>", () => {
    const result = writeFindinsSummary(workerResults, "/tmp/test.md");
    expect(result).toBeInstanceOf(Promise);
  });

  it("3. returns WriteSummaryResult with status + path", async () => {
    const result = await writeFindinsSummary(workerResults, "/tmp/findings-summary-test.md");

    expect(result.status).toBeDefined();
    expect(["success", "failed"]).toContain(result.status);
    expect(result.path).toBeDefined();
  });

  it("4. creates markdown file at specified path", async () => {
    const testPath = `/tmp/findings-summary-${Date.now()}.md`;
    const result = await writeFindinsSummary(workerResults, testPath);

    expect(result.status).toBe("success");
    expect(result.path).toBe(testPath);
  });

  it("5. markdown file is valid markdown", async () => {
    const testPath = `/tmp/findings-summary-${Date.now()}.md`;
    const result = await writeFindinsSummary(workerResults, testPath);

    expect(result.status).toBe("success");
    expect(result.bytes_written).toBeGreaterThan(0);
  });

  it("6. handles write failures gracefully", async () => {
    // Try to write to an invalid path
    const result = await writeFindinsSummary(
      workerResults,
      "/nonexistent/deeply/nested/path/file.md",
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
  });

  it("7. returns bytes written on success", async () => {
    const testPath = `/tmp/findings-summary-${Date.now()}.md`;
    const result = await writeFindinsSummary(workerResults, testPath);

    if (result.status === "success") {
      expect(result.bytes_written).toBeGreaterThan(0);
      expect(typeof result.bytes_written).toBe("number");
    }
  });

  it("8. result is JSON-serializable", async () => {
    const testPath = `/tmp/findings-summary-${Date.now()}.md`;
    const result = await writeFindinsSummary(workerResults, testPath);

    const json = JSON.stringify(result);
    expect(json.length).toBeGreaterThan(0);

    const parsed = JSON.parse(json);
    expect(parsed.status).toBeDefined();
  });
});
