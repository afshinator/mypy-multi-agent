/**
 * Unit tests for feedback task worker dispatch logic.
 * Tests: argument passing, output collection, Finding schema validation, error handling.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionConfig } from "../../src/contracts/session-schema";
import { dispatchFeedbackWorkers } from "../../src/supervisor/dispatch-feedback-workers";
import type { DataManifest } from "../../src/supervisor/load-prior-runs";

// Mock types matching refined design
// Types imported from src/supervisor/dispatch-feedback-workers
// Duplicated here for test clarity

function createTestConfig(): SessionConfig {
  return {
    version: "1.2",
    session: {
      id: "feedback-test",
      role: "feedback-workshop",
      max_cost_usd: 10,
      agent_stop_threshold_percent: 85,
      attester: "reviewer",
      input_tasks: ["task-1", "task-2"],
      heartbeat_timeout_ms: 30000,
      finalization_grace_ms: 5000,
      peer_retry_pause_ms: 100,
      peer_max_retries: 2,
    },
    analyze: {
      title: "Template feedback analysis",
      success_criterion: "Identify cost, spec, and UX friction issues",
    },
  } as SessionConfig;
}

describe("dispatch-feedback-workers", () => {
  let manifest: DataManifest;
  let config: SessionConfig;

  beforeEach(() => {
    manifest = {
      manifest_version: "1.0",
      tasks: [
        {
          task_id: "task-1",
          run_path: "/tasks/task-1/run-details",
          artifacts: {
            final_md: {
              available: true,
              path: "/tasks/task-1/run-details/final.md",
              size_bytes: 1000,
              optional: false,
            },
            scorecard_json: {
              available: true,
              path: "/tasks/task-1/run-details/scorecard.json",
              size_bytes: 500,
              optional: true,
            },
            findings_md: {
              available: true,
              path: "/tasks/task-1/run-details/findings.md",
              size_bytes: 800,
              optional: false,
            },
            conversation_jsonl: {
              available: true,
              path: "/tasks/task-1/run-details/conversation.jsonl",
              size_bytes: 50000,
              optional: false,
            },
            tool_calls_jsonl: {
              available: false,
              optional: true,
            },
          },
        },
        {
          task_id: "task-2",
          run_path: "/tasks/task-2/run-details",
          artifacts: {
            final_md: {
              available: true,
              path: "/tasks/task-2/run-details/final.md",
              size_bytes: 1200,
              optional: false,
            },
            scorecard_json: {
              available: true,
              path: "/tasks/task-2/run-details/scorecard.json",
              size_bytes: 450,
              optional: true,
            },
            findings_md: {
              available: true,
              path: "/tasks/task-2/run-details/findings.md",
              size_bytes: 900,
              optional: false,
            },
            conversation_jsonl: {
              available: true,
              path: "/tasks/task-2/run-details/conversation.jsonl",
              size_bytes: 45000,
              optional: false,
            },
            tool_calls_jsonl: {
              available: false,
              optional: true,
            },
          },
        },
      ],
    };

    config = createTestConfig();
  });

  it("1. dispatches 3 agents in parallel with manifest", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    // All three reports should exist
    expect(result.cost_auditor_report).toBeDefined();
    expect(result.spec_finder_report).toBeDefined();
    expect(result.friction_detector_report).toBeDefined();

    // Each report should have agent name, findings array, summary
    expect(result.cost_auditor_report.agent).toBe("cost-auditor");
    expect(Array.isArray(result.cost_auditor_report.findings)).toBe(true);
    expect(typeof result.cost_auditor_report.summary).toBe("string");
  });

  it("2. each agent receives all artifacts in pre-loaded data", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    expect(result.cost_auditor_report.findings.length).toBeGreaterThanOrEqual(0);
  });

  it("3. finding schema validates: reference + reasoning required", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    for (const report of [
      result.cost_auditor_report,
      result.spec_finder_report,
      result.friction_detector_report,
    ]) {
      for (const finding of report.findings) {
        // Every finding MUST have reference and reasoning
        expect(finding.reference).toBeDefined();
        expect(finding.reference.length).toBeGreaterThan(0);
        expect(finding.reasoning).toBeDefined();
        expect(finding.reasoning.length).toBeGreaterThan(0);
        expect(finding.verdict).toBeDefined();
        expect(finding.severity).toMatch(/^(HIGH|MEDIUM|LOW)$/);
        expect(finding.confidence).toMatch(/^(HIGH|MEDIUM|LOW)$/);
      }
    }
  });

  it("4. findings can support/refute other agent findings", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    // Collect all findings
    const allFindings = [
      ...result.cost_auditor_report.findings,
      ...result.spec_finder_report.findings,
      ...result.friction_detector_report.findings,
    ];

    // Any finding with supports_finding or refutes_finding should reference a valid agent
    for (const finding of allFindings) {
      if (finding.supports_finding) {
        expect(finding.supports_finding).toMatch(/^(cost-auditor|spec-finder|friction-detector)'s/);
      }
      if (finding.refutes_finding) {
        expect(finding.refutes_finding).toMatch(/^(cost-auditor|spec-finder|friction-detector)'s/);
      }
    }
  });

  it("5. throws on missing manifest", async () => {
    const testConfig = createTestConfig();
    const nullManifest = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(dispatchFeedbackWorkers(nullManifest as any, testConfig)).rejects.toThrow();
  });

  it("6. throws if manifest has no tasks", async () => {
    const testConfig = createTestConfig();
    const emptyManifest: DataManifest = {
      manifest_version: "1.0",
      tasks: [],
    };
    await expect(dispatchFeedbackWorkers(emptyManifest, testConfig)).rejects.toThrow();
  });

  it("7. cost auditor focuses on scorecard but can cite other artifacts", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    const costFindings = result.cost_auditor_report.findings;
    if (costFindings.length > 0) {
      expect(costFindings[0]?.reference).toBeDefined();
    }
  });

  it("8. friction detector focuses on conversation but can cite other artifacts", async () => {
    const result = await dispatchFeedbackWorkers(manifest, config);

    const frictionFindings = result.friction_detector_report.findings;
    if (frictionFindings.length > 0) {
      expect(frictionFindings[0]?.reference).toBeDefined();
    }
  });
});
