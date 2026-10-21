/**
 * Unit tests for Spec Finder system prompt refinement.
 * Tests: prompt structure, manifest injection, worked examples.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionConfig } from "../../src/contracts/session-schema";
import type { DataManifest } from "../../src/supervisor/load-prior-runs";
import { buildSpecFinderPrompt } from "../../src/supervisor/spec-finder-prompt";

describe("spec-finder-prompt", () => {
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
            tool_calls_jsonl: { available: false, optional: true },
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
            tool_calls_jsonl: { available: false, optional: true },
          },
        },
      ],
    };

    config = {
      version: "1.2",
      session: {
        id: "test",
        role: "feedback-workshop",
        max_cost_usd: 2,
        agent_stop_threshold_percent: 85,
        attester: "reviewer",
        input_tasks: ["task-1", "task-2"],
        heartbeat_timeout_ms: 30000,
        finalization_grace_ms: 5000,
        peer_retry_pause_ms: 100,
        peer_max_retries: 2,
      },
      analyze: {
        title: "Template feedback",
        success_criterion: "Output should be good and useful",
      },
    } as SessionConfig;
  });

  it("1. includes analyze block (success_criterion) in prompt", () => {
    const prompt = buildSpecFinderPrompt(manifest, config);

    expect(prompt).toContain("success_criterion");
    expect(prompt).toContain("Output should be good and useful");
  });

  it("2. includes worked example with all finding fields", () => {
    const prompt = buildSpecFinderPrompt(manifest, config);

    expect(prompt).toContain("verdict");
    expect(prompt).toContain("severity");
    expect(prompt).toContain("reference");
    expect(prompt).toContain("reasoning");
    expect(prompt).toContain("confidence");
  });

  it("3. instructs agent to look for vagueness", () => {
    const prompt = buildSpecFinderPrompt(manifest, config);

    const hasVaguenessCheck =
      prompt.includes("vague") || prompt.includes("ambiguous") || prompt.includes("unclear");

    expect(hasVaguenessCheck).toBe(true);
  });

  it("4. suggests focus on analyze block but allows conversation/final.md", () => {
    const prompt = buildSpecFinderPrompt(manifest, config);

    expect(prompt).toContain("analyze");
    const allowsOthers =
      prompt.includes("conversation") ||
      prompt.includes("final.md") ||
      prompt.includes("findings.md");

    expect(allowsOthers).toBe(true);
  });

  it("5. prompt is valid string suitable for LLM input", () => {
    const prompt = buildSpecFinderPrompt(manifest, config);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
    const hasRoleDescription = prompt.includes("Spec") || prompt.includes("Ambiguity");
    expect(hasRoleDescription).toBe(true);
  });
});
