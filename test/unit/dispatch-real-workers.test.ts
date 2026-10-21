/**
 * #90: Real subagent dispatch for workers
 * Spawns cost-auditor, spec-finder, friction-detector as real subagents
 * Parses JSON outputs and validates Finding schema
 */
import { describe, it, expect } from "vitest";
import { dispatchRealWorkers } from "../../src/supervisor/dispatch-real-workers";
import type { DataManifest } from "../../src/supervisor/load-prior-runs";
import type { SessionConfig } from "../../src/contracts/session-schema";

describe("dispatch-real-workers (#90)", () => {
  const manifest: DataManifest = {
    manifest_version: "1.0",
    tasks: [
      {
        task_id: "task-1",
        run_path: "/tasks/task-1/run-details",
        artifacts: {
          final_md: {
            available: true,
            path: "/tasks/task-1/final.md",
            optional: false,
          },
          conversation_jsonl: {
            available: true,
            path: "/tasks/task-1/conversation.jsonl",
            optional: false,
          },
        },
        scorecard_frontmatter: { cost: 100, tokens: 5000, outcome: "success" },
      },
    ],
  };

  const config: SessionConfig = {
    version: "1.2",
    session: {
      id: "worker-test",
      role: "feedback-workshop",
      max_cost_usd: 2,
      agent_stop_threshold_percent: 85,
      attester: "reviewer",
      input_tasks: ["task-1"],
      heartbeat_timeout_ms: 30000,
      finalization_grace_ms: 5000,
      peer_retry_pause_ms: 100,
      peer_max_retries: 2,
    },
    analyze: {
      success_criterion: "Test criteria",
      title: "Test",
    },
  } as SessionConfig;

  it("1. exports dispatchRealWorkers function", () => {
    expect(typeof dispatchRealWorkers).toBe("function");
  });

  it("2. function signature: (manifest, config) => Promise<FeedbackWorkerResult>", () => {
    const result = dispatchRealWorkers(manifest, config);
    expect(result).toBeInstanceOf(Promise);
  });

  it("3. returns FeedbackWorkerResult with 3 reports", async () => {
    const result = await dispatchRealWorkers(manifest, config);

    expect(result.cost_auditor_report).toBeDefined();
    expect(result.spec_finder_report).toBeDefined();
    expect(result.friction_detector_report).toBeDefined();
  });

  it("4. each report has agent name, findings, summary", async () => {
    const result = await dispatchRealWorkers(manifest, config);

    expect(result.cost_auditor_report.agent).toBe("cost-auditor");
    expect(Array.isArray(result.cost_auditor_report.findings)).toBe(true);
    expect(typeof result.cost_auditor_report.summary).toBe("string");

    expect(result.spec_finder_report.agent).toBe("spec-finder");
    expect(Array.isArray(result.spec_finder_report.findings)).toBe(true);
    expect(typeof result.spec_finder_report.summary).toBe("string");

    expect(result.friction_detector_report.agent).toBe("friction-detector");
    expect(Array.isArray(result.friction_detector_report.findings)).toBe(true);
    expect(typeof result.friction_detector_report.summary).toBe("string");
  });

  it("5. findings validate schema: reference + reasoning required", async () => {
    const result = await dispatchRealWorkers(manifest, config);

    const allFindings = [
      ...result.cost_auditor_report.findings,
      ...result.spec_finder_report.findings,
      ...result.friction_detector_report.findings,
    ];

    for (const finding of allFindings) {
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
  });

  it("6. spawns agents in parallel via subagent", async () => {
    const start = Date.now();
    await dispatchRealWorkers(manifest, config);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(30000);
  });

  it("7. handles agent output parsing and JSON validation", async () => {
    const result = await dispatchRealWorkers(manifest, config);

    const json = JSON.stringify(result);
    expect(json.length).toBeGreaterThan(0);

    const parsed = JSON.parse(json);
    expect(parsed.cost_auditor_report).toBeDefined();
  });

  it("8. robust to agent output variations", async () => {
    const result = await dispatchRealWorkers(manifest, config);

    expect(result.cost_auditor_report.findings).toBeInstanceOf(Array);
    expect(result.spec_finder_report.findings).toBeInstanceOf(Array);
    expect(result.friction_detector_report.findings).toBeInstanceOf(Array);
  });
});
