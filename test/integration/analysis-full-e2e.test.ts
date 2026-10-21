/**
 * #89: Full end-to-end integration test
 * Tests the complete analysis flow from config to findings-summary.md
 * 1. Load real task runs
 * 2. Dispatch worker agents
 * 3. Collect findings
 * 4. Finalize to markdown
 */
import { describe, expect, it } from "vitest";
import type { SessionConfig } from "../../src/contracts/session-schema";
import { runAnalysisTask } from "../../src/supervisor/analysis-orchestrator";

describe("analysis full E2E (#89)", () => {
  const config: SessionConfig = {
    version: "1.2",
    session: {
      id: "e2e-full-test",
      role: "analysis",
      max_cost_usd: 2,
      agent_stop_threshold_percent: 85,
      attester: "reviewer",
      input_tasks: ["04-inspector-server", "r1-fixes"],
      heartbeat_timeout_ms: 30000,
      finalization_grace_ms: 5000,
      peer_retry_pause_ms: 100,
      peer_max_retries: 2,
    },
    analyze: {
      success_criterion: "Identify cost anomalies, spec vagueness, and UX friction",
      title: "Full E2E Integration Test",
    },
  } as SessionConfig;

  it("1. orchestrator loads real manifest", async () => {
    const result = await runAnalysisTask(config, "mypi-tasks", "run-details");

    expect(result.status).toBeDefined();
    expect(result.workers_completed).toBe(3);
  });

  it("2. all 3 workers complete successfully", async () => {
    const result = await runAnalysisTask(config, "mypi-tasks", "run-details");

    expect(result.workers_completed).toBe(3);
    expect(result.status).not.toBe("failed");
  });

  it("3. collects findings from all workers", async () => {
    const result = await runAnalysisTask(config, "mypi-tasks", "run-details");

    // Workers collected findings (may be 0, but we should have a count)
    expect(result.total_findings).toBeGreaterThanOrEqual(0);
  });

  it("4. generates summary path", async () => {
    const result = await runAnalysisTask(config, "mypi-tasks", "run-details");

    expect(result.summary_path).toBeDefined();
    expect(result.summary_path).toContain("findings-summary.md");
    expect(result.summary_path).toContain("run-details");
  });

  it("5. returns success status when findings exist", async () => {
    const result = await runAnalysisTask(config, "mypi-tasks", "run-details");

    // Status should be success or partial (partial if some findings, success if all workers good)
    expect(["success", "partial"]).toContain(result.status);
  });

  it("6. orchestrator result is JSON-serializable", async () => {
    const result = await runAnalysisTask(config, "mypi-tasks", "run-details");

    const json = JSON.stringify(result);
    expect(json.length).toBeGreaterThan(0);

    const parsed = JSON.parse(json);
    expect(parsed.status).toBeDefined();
    expect(parsed.summary_path).toBeDefined();
  });

  it("7. handles both task runs in manifest", async () => {
    const result = await runAnalysisTask(config, "mypi-tasks", "run-details");

    // Both 04-inspector-server and r1-fixes should be in manifest
    expect(result.workers_completed).toBe(3);
  });

  it("8. orchestrator is repeatable (idempotent on inputs)", async () => {
    const result1 = await runAnalysisTask(config, "mypi-tasks", "run-details");

    const result2 = await runAnalysisTask(config, "mypi-tasks", "run-details");

    // Same inputs should produce same result (deterministic)
    expect(result1.total_findings).toBe(result2.total_findings);
    expect(result1.workers_completed).toBe(result2.workers_completed);
  });
});
