/**
 * #88: Task orchestrator test suite
 * Orchestrates the full feedback-workshop flow:
 * 1. Load prior task runs
 * 2. Dispatch 3 worker agents
 * 3. Collect findings
 * 4. Finalize to findings-summary.md
 */
import { describe, it, expect } from "vitest";
import { feedbackWorkshopOrchestrator } from "../../src/supervisor/feedback-workshop-orchestrator";
import type { SessionConfig } from "../../src/contracts/session-schema";

describe("feedback-workshop orchestrator (#88)", () => {
  const config: SessionConfig = {
    version: "1.2",
    session: {
      id: "orch-test",
      role: "feedback-workshop",
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
      success_criterion: "Identify cost, spec, and UX friction issues",
      title: "Pilot Feedback Workshop",
    },
  } as SessionConfig;

  it("1. executes full orchestration flow with real manifest", async () => {
    const result = await feedbackWorkshopOrchestrator(config, "mypi-tasks", "run-details");

    expect(result.status).toBeDefined();
    expect(["success", "partial", "failed"]).toContain(result.status);
  });

  it("2. returns OrchestratorResult with all fields", async () => {
    const result = await feedbackWorkshopOrchestrator(config, "mypi-tasks", "run-details");

    expect(result.summary_path).toBeDefined();
    expect(result.workers_completed).toBeDefined();
    expect(result.reviewer_completed).toBeDefined();
    expect(result.total_findings).toBeDefined();
  });

  it("3. loads manifest from input tasks", async () => {
    const result = await feedbackWorkshopOrchestrator(config, "mypi-tasks", "run-details");

    // If manifest loaded successfully, we should have at least partial results
    expect(result.workers_completed).toBeGreaterThan(0);
  });

  it("4. counts all 3 workers as completed", async () => {
    const result = await feedbackWorkshopOrchestrator(config, "mypi-tasks", "run-details");

    // All 3 workers complete even if they find 0 findings
    expect(result.workers_completed).toBe(3);
  });

  it("5. counts total findings across all workers", async () => {
    const result = await feedbackWorkshopOrchestrator(config, "mypi-tasks", "run-details");

    expect(typeof result.total_findings).toBe("number");
    expect(result.total_findings).toBeGreaterThanOrEqual(0);
  });

  it("6. summary path is set correctly", async () => {
    const result = await feedbackWorkshopOrchestrator(config, "mypi-tasks", "run-details");

    expect(result.summary_path).toContain("findings-summary.md");
  });

  it("7. handles missing taskDir gracefully", async () => {
    const result = await feedbackWorkshopOrchestrator(config, "/nonexistent/path", "run-details");

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
  });

  it("8. handles invalid config gracefully", async () => {
    const invalidConfig = {
      session: {
        role: "standard", // Wrong role!
      },
    } as SessionConfig;

    const result = await feedbackWorkshopOrchestrator(invalidConfig, "mypi-tasks", "run-details");

    expect(result.status).toBe("failed");
  });
});
