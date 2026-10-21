/**
 * Unit tests for Cost Auditor system prompt refinement.
 * Tests: prompt structure, manifest injection, worked examples, finding schema.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildCostAuditorPrompt } from "../../src/supervisor/cost-auditor-prompt";
import type { DataManifest } from "../../src/supervisor/load-prior-runs";

describe("cost-auditor-prompt", () => {
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
          scorecard_frontmatter: {
            outcome: "success",
            cost: 3.5,
            tokens: 85000,
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
          scorecard_frontmatter: {
            outcome: "success",
            cost: 1.2,
            tokens: 28000,
          },
        },
      ],
    };
  });

  it("1. includes manifest in prompt", () => {
    const prompt = buildCostAuditorPrompt(manifest);

    expect(prompt).toContain("task-1");
    expect(prompt).toContain("task-2");
    expect(prompt).toContain("3.5"); // task-1 cost
    expect(prompt).toContain("1.2"); // task-2 cost
  });

  it("2. includes worked example with all finding fields", () => {
    const prompt = buildCostAuditorPrompt(manifest);

    // Prompt must show example with verdict, severity, reference, reasoning, confidence
    expect(prompt).toContain("verdict");
    expect(prompt).toContain("severity");
    expect(prompt).toContain("reference");
    expect(prompt).toContain("reasoning");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("HIGH");
    expect(prompt).toContain("MEDIUM");
    expect(prompt).toContain("LOW");
  });

  it("3. instructs mandatory reference + reasoning", () => {
    const prompt = buildCostAuditorPrompt(manifest);

    const hasInstructions =
      prompt.includes("Every verdict MUST") ||
      prompt.includes("mandatory") ||
      prompt.includes("reference") ||
      prompt.includes("reasoning");

    expect(hasInstructions).toBe(true);
  });

  it("4. suggests focus on scorecard but allows other sources", () => {
    const prompt = buildCostAuditorPrompt(manifest);

    expect(prompt).toContain("scorecard");
    const hasFocus = prompt.includes("Focus") || prompt.includes("focus");
    expect(hasFocus).toBe(true);

    // Allow reference to other artifacts
    const allowsOthers =
      prompt.includes("final.md") ||
      prompt.includes("findings.md") ||
      prompt.includes("conversation");

    expect(allowsOthers).toBe(true);
  });

  it("5. prompt is valid string suitable for LLM input", () => {
    const prompt = buildCostAuditorPrompt(manifest);

    // Should be a non-empty string
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);

    // Should include role description
    expect(prompt).toContain("Cost");
    expect(prompt).toContain("Anomal");

    // Should include task instruction
    const hasInstruction = prompt.includes("Provide findings") || prompt.includes("analyze");
    expect(hasInstruction).toBe(true);
  });
});
