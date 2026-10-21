/**
 * #92: Subagent task dispatch for worker agents
 * Converts worker prompts + manifest into subagent tasks
 * Handles result parsing and schema validation
 */
import { describe, expect, it } from "vitest";
import type { SessionConfig } from "../../src/contracts/session-schema";
import type { DataManifest } from "../../src/supervisor/load-prior-runs";
import { buildWorkerTasks } from "../../src/supervisor/subagent-task-dispatch";

describe("subagent-task-dispatch (#92)", () => {
  const manifest: DataManifest = {
    manifest_version: "1.0",
    tasks: [
      {
        task_id: "task-1",
        run_path: "/tasks/task-1/run-details",
        artifacts: {
          final_md: { available: true, path: "/tasks/task-1/final.md", optional: false },
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
      id: "task-dispatch-test",
      role: "analysis",
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

  it("1. exports buildWorkerTasks function", () => {
    expect(typeof buildWorkerTasks).toBe("function");
  });

  it("2. returns array of 3 tasks", () => {
    const tasks = buildWorkerTasks(manifest, config);

    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(3);
  });

  it("3. each task has agent, id, prompt fields", () => {
    const tasks = buildWorkerTasks(manifest, config);

    for (const task of tasks) {
      expect(task.agent).toBeDefined();
      expect(["cost-auditor", "spec-finder", "friction-detector"]).toContain(task.agent);
      expect(task.id).toBeDefined();
      expect(task.prompt).toBeDefined();
      expect(typeof task.prompt).toBe("string");
      expect(task.prompt.length).toBeGreaterThan(100);
    }
  });

  it("4. cost-auditor task includes scorecard focus", () => {
    const tasks = buildWorkerTasks(manifest, config);
    const costTask = tasks.find((t) => t.agent === "cost-auditor");

    expect(costTask?.prompt).toContain("scorecard");
    expect(costTask?.prompt).toContain("cost");
  });

  it("5. spec-finder task includes analyze block focus", () => {
    const tasks = buildWorkerTasks(manifest, config);
    const specTask = tasks.find((t) => t.agent === "spec-finder");

    expect(specTask?.prompt).toContain("analyze");
    expect(specTask?.prompt).toContain("success_criterion");
  });

  it("6. friction-detector task includes conversation focus", () => {
    const tasks = buildWorkerTasks(manifest, config);
    const frictionTask = tasks.find((t) => t.agent === "friction-detector");

    expect(frictionTask?.prompt).toContain("conversation");
  });

  it("7. tasks include manifest data", () => {
    const tasks = buildWorkerTasks(manifest, config);

    for (const task of tasks) {
      // Manifest should be injected into the prompt somehow
      expect(task.prompt).toContain("task-1");
    }
  });

  it("8. tasks are JSON-serializable for subagent", () => {
    const tasks = buildWorkerTasks(manifest, config);

    const json = JSON.stringify(tasks);
    expect(json.length).toBeGreaterThan(0);

    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(3);
  });
});
