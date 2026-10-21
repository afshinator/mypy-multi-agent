/**
 * Unit tests for Friction Detector system prompt refinement.
 * Tests: prompt structure, conversation.jsonl focus, worked examples.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildFrictionDetectorPrompt } from "../../src/supervisor/friction-detector-prompt";
import type { DataManifest } from "../../src/supervisor/load-prior-runs";

describe("friction-detector-prompt", () => {
  let manifest: DataManifest;

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
  });

  it("1. includes manifest with conversation.jsonl paths", () => {
    const prompt = buildFrictionDetectorPrompt(manifest);

    expect(prompt).toContain("conversation.jsonl");
    expect(prompt).toContain("task-1");
    expect(prompt).toContain("task-2");
  });

  it("2. includes worked example with all finding fields", () => {
    const prompt = buildFrictionDetectorPrompt(manifest);

    expect(prompt).toContain("verdict");
    expect(prompt).toContain("severity");
    expect(prompt).toContain("reference");
    expect(prompt).toContain("reasoning");
    expect(prompt).toContain("confidence");
  });

  it("3. instructs agent to look for communication friction", () => {
    const prompt = buildFrictionDetectorPrompt(manifest);

    const hasFrictionCheck =
      prompt.includes("clarification") ||
      prompt.includes("confusion") ||
      prompt.includes("friction") ||
      prompt.includes("struggling");

    expect(hasFrictionCheck).toBe(true);
  });

  it("4. suggests focus on conversation.jsonl but allows other sources", () => {
    const prompt = buildFrictionDetectorPrompt(manifest);

    expect(prompt).toContain("conversation");
    const allowsOthers =
      prompt.includes("final.md") || prompt.includes("scorecard") || prompt.includes("findings.md");

    expect(allowsOthers).toBe(true);
  });

  it("5. prompt is valid string suitable for LLM input", () => {
    const prompt = buildFrictionDetectorPrompt(manifest);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
    const hasRoleDescription = prompt.includes("Friction") || prompt.includes("UX");
    expect(hasRoleDescription).toBe(true);
  });
});
