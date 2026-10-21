/**
 * #85: Integration test — feedback-workshop end-to-end
 * Loads real prior task artifacts and verifies full dispatch flow.
 *
 * Uses real task runs from mypi-tasks/:
 * - 04-inspector-server: Has final.md + conversation.jsonl (no scorecard)
 * - r1-fixes: Has final.md + conversation.jsonl + scorecard.json
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SessionConfig } from "../../src/contracts/session-schema";
import { dispatchFeedbackWorkers } from "../../src/supervisor/dispatch-feedback-workers";
import { loadFeedbackWorkshopArtifacts } from "../../src/supervisor/load-prior-runs";

describe("feedback-workshop E2E integration (#85)", () => {
  let manifest: Awaited<ReturnType<typeof loadFeedbackWorkshopArtifacts>>;
  const config: SessionConfig = {
    version: "1.2",
    session: {
      id: "e2e-test",
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
      success_criterion: "Identify cost anomalies, spec vagueness, and UX friction",
      title: "Feedback Workshop Pilot",
    },
  } as SessionConfig;

  beforeAll(async () => {
    // Load real manifest from prior task runs
    const taskDir = "mypi-tasks";
    manifest = await loadFeedbackWorkshopArtifacts(config, taskDir);
  });

  it("1. loads real manifest with 2 tasks", () => {
    expect(manifest).toBeDefined();
    expect(manifest.manifest_version).toBe("1.0");
    expect(manifest.tasks).toHaveLength(2);

    const taskIds = manifest.tasks.map((t) => t.task_id);
    expect(taskIds.length).toBe(2);
  });

  it("2. real tasks have expected artifacts", () => {
    // All tasks should have final.md and conversation.jsonl
    for (const task of manifest.tasks) {
      expect(task.artifacts?.final_md?.available).toBe(true);
      expect(task.artifacts?.conversation_jsonl?.available).toBe(true);
    }
  });

  it("3. dispatches feedback workers with real manifest", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    expect(result).toBeDefined();
    expect(result.cost_auditor_report).toBeDefined();
    expect(result.spec_finder_report).toBeDefined();
    expect(result.friction_detector_report).toBeDefined();
  });

  it("4. cost auditor analyzes real scorecard data", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);
    const report = result.cost_auditor_report;

    expect(report.agent).toBe("cost-auditor");
    expect(report.summary).toBeDefined();
    expect(report.summary.length).toBeGreaterThan(0);

    // If any task has scorecard cost, cost auditor should have findings
    const hasScorecardCost = manifest.tasks.some((t) => t.scorecard_frontmatter?.cost);
    if (hasScorecardCost) {
      expect(report.findings.length).toBeGreaterThan(0);
      const costFinding = report.findings[0];
      expect(costFinding?.reference).toBeDefined();
      expect(costFinding?.reasoning).toBeDefined();
    }
  });

  it("5. spec finder analyzes success_criterion", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);
    const report = result.spec_finder_report;

    expect(report.agent).toBe("spec-finder");
    expect(report.summary).toBeDefined();
    expect(report.findings.length).toBeGreaterThan(0);

    const specFinding = report.findings[0];
    expect(specFinding?.verdict).toContain("Success criterion");
    expect(specFinding?.reference).toContain("success_criterion");
    expect(specFinding?.reference).toContain(
      "Identify cost anomalies, spec vagueness, and UX friction",
    );
    expect(specFinding?.reasoning.length).toBeGreaterThan(0);
  });

  it("6. friction detector analyzes conversation data", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);
    const report = result.friction_detector_report;

    expect(report.agent).toBe("friction-detector");
    expect(report.summary).toBeDefined();
    // Friction detector should have findings if conversation.jsonl is available
    const hasConversation = manifest.tasks.some((t) => t.artifacts?.conversation_jsonl?.available);
    if (hasConversation) {
      expect(report.findings.length).toBeGreaterThan(0);
      const frictionFinding = report.findings[0];
      expect(frictionFinding?.verdict).toBeDefined();
      expect(frictionFinding?.reasoning.length).toBeGreaterThan(0);
    }
  });

  it("7. all findings enforce reference + reasoning", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    const allReports = [
      result.cost_auditor_report,
      result.spec_finder_report,
      result.friction_detector_report,
    ];

    for (const report of allReports) {
      for (const finding of report.findings) {
        // Every finding must have these mandatory fields
        expect(finding.reference).toBeDefined();
        expect(typeof finding.reference).toBe("string");
        expect(finding.reference.length).toBeGreaterThan(0);

        expect(finding.reasoning).toBeDefined();
        expect(typeof finding.reasoning).toBe("string");
        expect(finding.reasoning.length).toBeGreaterThan(0);

        expect(finding.verdict).toBeDefined();
        expect(["HIGH", "MEDIUM", "LOW"]).toContain(finding.severity);
        expect(["HIGH", "MEDIUM", "LOW"]).toContain(finding.confidence);
      }
    }
  });

  it("8. findings reference real manifest data", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    // Collect all references from all findings
    const allReferences: string[] = [];
    [
      result.cost_auditor_report,
      result.spec_finder_report,
      result.friction_detector_report,
    ].forEach((report) => {
      report.findings.forEach((f) => {
        allReferences.push(f.reference);
      });
    });

    // References should mention artifacts or analysis
    const hasArtifactRef = allReferences.some(
      (ref) =>
        ref.includes("scorecard") ||
        ref.includes("conversation") ||
        ref.includes("success_criterion") ||
        ref.includes("final.md") ||
        ref.includes("analyze"),
    );
    expect(hasArtifactRef).toBe(true);
  });

  it("9. reports have summaries", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    expect(result.cost_auditor_report.summary.length).toBeGreaterThan(0);
    expect(result.spec_finder_report.summary.length).toBeGreaterThan(0);
    expect(result.friction_detector_report.summary.length).toBeGreaterThan(0);
  });

  it("10. result is serializable to JSON", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    const json = JSON.stringify(result);
    expect(json.length).toBeGreaterThan(0);

    const parsed = JSON.parse(json);
    expect(parsed.cost_auditor_report).toBeDefined();
    expect(parsed.spec_finder_report).toBeDefined();
    expect(parsed.friction_detector_report).toBeDefined();
  });
});
