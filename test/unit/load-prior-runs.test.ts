/**
 * Unit tests for feedback-workshop artifact loading and data manifest construction.
 */
import { mkdirSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadFeedbackWorkshopArtifacts } from "../../src/supervisor/load-prior-runs";
import type { SessionConfig } from "../../src/contracts/session-schema";

function createTestConfig(input_tasks: string[]): SessionConfig {
  return {
    version: "1.2",
    session: {
      id: "test",
      role: "feedback-workshop",
      max_cost_usd: 2,
      agent_stop_threshold_percent: 85,
      attester: "reviewer",
      input_tasks,
      heartbeat_timeout_ms: 30000,
      finalization_grace_ms: 5000,
      peer_retry_pause_ms: 100,
      peer_max_retries: 2,
    },
    analyze: {
      title: "Test",
      success_criterion: "test",
    },
  } as SessionConfig;
}

describe("load-prior-runs", () => {
  let testDir: string;
  let taskDir: string;
  let task1Dir: string;
  let task2Dir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `fw-test-${Date.now()}`);
    taskDir = join(testDir, "tasks");
    task1Dir = join(taskDir, "task-1", "run-details");
    task2Dir = join(taskDir, "task-2", "run-details");

    mkdirSync(taskDir, { recursive: true });
    mkdirSync(task1Dir, { recursive: true });
    mkdirSync(task2Dir, { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    const cleanup = (dir: string) => {
      try {
        if (dir.includes("fw-test")) {
          const files = require("fs").readdirSync(dir);
          for (const f of files) {
            const p = join(dir, f);
            if (require("fs").statSync(p).isDirectory()) cleanup(p);
            else unlinkSync(p);
          }
          rmdirSync(dir);
        }
      } catch {
        // ignore
      }
    };
    cleanup(testDir);
  });

  it("1. loads artifacts from valid task paths", async () => {
    writeFileSync(join(task1Dir, "final.md"), "# Final\n");
    writeFileSync(join(task1Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task1Dir, "conversation.jsonl"), "{}");
    writeFileSync(join(task2Dir, "final.md"), "# Final\n");
    writeFileSync(join(task2Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task2Dir, "conversation.jsonl"), "{}");

    const config = createTestConfig(["task-1", "task-2"]);
    const manifest = await loadFeedbackWorkshopArtifacts(config, taskDir);

    expect(manifest.manifest_version).toBe("1.0");
    expect(manifest.tasks).toHaveLength(2);
    expect(manifest.tasks[0]?.task_id).toBe("task-1");
    expect(manifest.tasks[1]?.task_id).toBe("task-2");
    expect(manifest.tasks[0]?.artifacts?.final_md?.available).toBe(true);
    expect(manifest.tasks[0]?.artifacts?.findings_md?.available).toBe(true);
  });

  it("2. handles missing artifacts gracefully", async () => {
    writeFileSync(join(task1Dir, "final.md"), "# Final\n");
    writeFileSync(join(task1Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task1Dir, "conversation.jsonl"), "{}");
    writeFileSync(join(task1Dir, "scorecard.json"), '{"outcome":"success"}');

    writeFileSync(join(task2Dir, "final.md"), "# Final\n");
    writeFileSync(join(task2Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task2Dir, "conversation.jsonl"), "{}");

    const config = createTestConfig(["task-1", "task-2"]);
    const manifest = await loadFeedbackWorkshopArtifacts(config, taskDir);

    expect(manifest.tasks[0]?.artifacts?.scorecard_json?.available).toBe(true);
    expect(manifest.tasks[1]?.artifacts?.scorecard_json?.available).toBe(false);
    expect(manifest.tasks[1]?.artifacts?.scorecard_json?.path).toBeUndefined();
  });

  it("3. throws on missing task path", async () => {
    writeFileSync(join(task1Dir, "final.md"), "# Final\n");
    writeFileSync(join(task1Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task1Dir, "conversation.jsonl"), "{}");

    const config = createTestConfig(["task-1", "nonexistent"]);

    await expect(loadFeedbackWorkshopArtifacts(config, taskDir)).rejects.toThrow();
  });

  it("4. throws if too few tasks resolve successfully", async () => {
    writeFileSync(join(task1Dir, "final.md"), "# Final\n");
    writeFileSync(join(task1Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task1Dir, "conversation.jsonl"), "{}");

    const config = createTestConfig(["task-1"]);

    await expect(loadFeedbackWorkshopArtifacts(config, taskDir)).rejects.toThrow();
  });

  it("5. includes file sizes in artifact info", async () => {
    const content = "test content";
    writeFileSync(join(task1Dir, "final.md"), content);
    writeFileSync(join(task1Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task1Dir, "conversation.jsonl"), "{}");
    writeFileSync(join(task2Dir, "final.md"), "# Final\n");
    writeFileSync(join(task2Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task2Dir, "conversation.jsonl"), "{}");

    const config = createTestConfig(["task-1", "task-2"]);
    const manifest = await loadFeedbackWorkshopArtifacts(config, taskDir);

    const finalArtifact = manifest.tasks[0]?.artifacts.final_md;
    expect(finalArtifact?.available).toBe(true);
    expect(finalArtifact?.size_bytes).toBeGreaterThan(0);
    expect(finalArtifact?.path).toBeDefined();
  });

  it("6. resolves relative paths correctly", async () => {
    writeFileSync(join(task1Dir, "final.md"), "# Final\n");
    writeFileSync(join(task1Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task1Dir, "conversation.jsonl"), "{}");
    writeFileSync(join(task2Dir, "final.md"), "# Final\n");
    writeFileSync(join(task2Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task2Dir, "conversation.jsonl"), "{}");

    const config = createTestConfig(["task-1", "task-2"]);
    const manifest = await loadFeedbackWorkshopArtifacts(config, taskDir);

    expect(manifest.tasks[0]?.run_path).toBe(task1Dir);
    expect(manifest.tasks[1]?.run_path).toBe(task2Dir);
    expect(manifest.tasks[0]?.run_path).toMatch(/^\/|^[A-Z]:/);
  });

  it("7. extracts scorecard frontmatter if available", async () => {
    writeFileSync(join(task1Dir, "final.md"), "# Final\n");
    writeFileSync(join(task1Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task1Dir, "conversation.jsonl"), "{}");
    writeFileSync(
      join(task1Dir, "scorecard.json"),
      JSON.stringify({
        outcome: "success",
        cost: { totalCostUsd: 1.5, totalTokens: 50000 },
      }),
    );
    writeFileSync(join(task2Dir, "final.md"), "# Final\n");
    writeFileSync(join(task2Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task2Dir, "conversation.jsonl"), "{}");

    const config = createTestConfig(["task-1", "task-2"]);
    const manifest = await loadFeedbackWorkshopArtifacts(config, taskDir);

    expect(manifest.tasks[0]?.scorecard_frontmatter).toBeDefined();
    expect(manifest.tasks[0]?.scorecard_frontmatter?.outcome).toBe("success");
    expect(manifest.tasks[1]?.scorecard_frontmatter).toBeUndefined();
  });

  it("8. marks artifacts as optional/required", async () => {
    writeFileSync(join(task1Dir, "final.md"), "# Final\n");
    writeFileSync(join(task1Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task1Dir, "conversation.jsonl"), "{}");
    writeFileSync(join(task2Dir, "final.md"), "# Final\n");
    writeFileSync(join(task2Dir, "findings.md"), "# Findings\n");
    writeFileSync(join(task2Dir, "conversation.jsonl"), "{}");

    const config = createTestConfig(["task-1", "task-2"]);
    const manifest = await loadFeedbackWorkshopArtifacts(config, taskDir);

    expect(manifest.tasks[0]?.artifacts?.final_md?.optional).toBe(false);
    expect(manifest.tasks[0]?.artifacts?.findings_md?.optional).toBe(false);
    expect(manifest.tasks[0]?.artifacts?.scorecard_json?.optional).toBe(true);
    expect(manifest.tasks[0]?.artifacts?.tool_calls_jsonl?.optional).toBe(true);
  });
});
