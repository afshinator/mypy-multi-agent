/**
 * #86: Reviewer system prompt test suite
 * Reviewer agent validates findings from 3 workers with evidence citations.
 */
import { describe, expect, it } from "vitest";
import type { FeedbackWorkerResult } from "../../src/supervisor/dispatch-feedback-workers";
import type { DataManifest } from "../../src/supervisor/load-prior-runs";
import { buildReviewerPrompt } from "../../src/supervisor/reviewer-prompt";

describe("reviewer-prompt", () => {
  const manifest: DataManifest = {
    manifest_version: "1.0",
    tasks: [
      {
        task_id: "task-1",
        run_path: "/tasks/task-1/run-details",
        artifacts: {
          final_md: { available: true, path: "/tasks/task-1/final.md", optional: false },
          conversation_jsonl: { available: true, path: "/tasks/task-1/conversation.jsonl", optional: false },
        },
        scorecard_frontmatter: { cost: 100, tokens: 5000, outcome: "success" },
      },
    ],
  };

  const workerResults: FeedbackWorkerResult = {
    cost_auditor_report: {
      agent: "cost-auditor",
      findings: [
        {
          verdict: "Task cost is high",
          severity: "HIGH",
          reference: "scorecard.json: cost=$100",
          reasoning: "Significantly above peer average",
          confidence: "HIGH",
        },
      ],
      summary: "Found 1 cost anomaly",
    },
    spec_finder_report: {
      agent: "spec-finder",
      findings: [
        {
          verdict: "Success criterion is vague",
          severity: "MEDIUM",
          reference: "analyze block: success_criterion = 'Do the thing'",
          reasoning: "Lacks measurable outcomes",
          confidence: "MEDIUM",
        },
      ],
      summary: "Found vagueness in spec",
    },
    friction_detector_report: {
      agent: "friction-detector",
      findings: [
        {
          verdict: "Multiple clarification loops",
          severity: "MEDIUM",
          reference: "conversation.jsonl: lines 45-78 show 3 loops",
          reasoning: "Agent asked for clarification 3 times",
          confidence: "HIGH",
        },
      ],
      summary: "Found 1 friction pattern",
    },
  };

  it("1. includes all 3 worker reports in the prompt", () => {
    const prompt = buildReviewerPrompt(manifest, workerResults);

    expect(prompt).toContain("cost-auditor");
    expect(prompt).toContain("spec-finder");
    expect(prompt).toContain("friction-detector");
  });

  it("2. includes worker findings with reference + reasoning", () => {
    const prompt = buildReviewerPrompt(manifest, workerResults);

    // Cost auditor finding
    expect(prompt).toContain("Task cost is high");
    expect(prompt).toContain("scorecard.json: cost=$100");
    expect(prompt).toContain("Significantly above peer average");

    // Spec finder finding
    expect(prompt).toContain("Success criterion is vague");
    expect(prompt).toContain("Do the thing");

    // Friction detector finding
    expect(prompt).toContain("Multiple clarification loops");
    expect(prompt).toContain("conversation.jsonl");
  });

  it("3. instructs reviewer to validate findings", () => {
    const prompt = buildReviewerPrompt(manifest, workerResults);

    expect(prompt.toLowerCase()).toMatch(/validate|ground-?check|verify|evidence/i);
  });

  it("4. provides manifest and artifact paths for reference", () => {
    const prompt = buildReviewerPrompt(manifest, workerResults);

    expect(prompt).toContain("task-1");
    expect(prompt).toContain("final.md");
    expect(prompt).toContain("conversation.jsonl");
  });

  it("5. includes worked example of reviewer validation", () => {
    const prompt = buildReviewerPrompt(manifest, workerResults);

    // Should have at least one example showing validation logic
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).toMatch(/example|e\.g\.|for instance|suppose/i);
  });

  it("6. instructs reviewer to support or refute findings", () => {
    const prompt = buildReviewerPrompt(manifest, workerResults);

    expect(prompt.toLowerCase()).toMatch(/support|refute|agree|disagree|confirm|dispute/i);
  });

  it("7. prompt is valid string suitable for LLM input", () => {
    const prompt = buildReviewerPrompt(manifest, workerResults);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });
});
