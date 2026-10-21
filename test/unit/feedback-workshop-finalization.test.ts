/**
 * #87: Finalization logic test suite
 * Collects worker findings + reviewer validations and formats findings-summary.md
 */
import { describe, it, expect } from "vitest";
import { finalizeFeedbackWorkshop } from "../../src/supervisor/feedback-workshop-finalization";
import type { FeedbackWorkerResult } from "../../src/supervisor/dispatch-feedback-workers";

describe("feedback-workshop finalization (#87)", () => {
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
          reference: "conversation.jsonl: lines 45-78",
          reasoning: "Agent asked for clarification 3 times",
          confidence: "HIGH",
        },
      ],
      summary: "Found 1 friction pattern",
    },
    reviewer_report: {
      agent: "reviewer",
      validations: [
        {
          finding_index: 0,
          agent: "cost-auditor",
          verdict: "support",
          severity_validated: "HIGH",
          reasoning: "Cost data is verifiable",
          evidence: "scorecard.json shows exact cost",
        },
        {
          finding_index: 1,
          agent: "spec-finder",
          verdict: "support_with_caveats",
          severity_validated: "MEDIUM",
          reasoning: "Spec is vague but not blocking",
          evidence: "criterion stated but not measurable",
          refinements: "Severity MEDIUM is more accurate than HIGH",
        },
        {
          finding_index: 2,
          agent: "friction-detector",
          verdict: "refute",
          severity_validated: "LOW",
          reasoning: "Clarifications were productive",
          evidence: "agent understood after each clarification",
        },
      ],
      summary: "Validated 3 findings; 1 refuted, 1 supported, 1 with caveats",
    },
  };

  it("1. generates findings-summary markdown with title", () => {
    const summary = finalizeFeedbackWorkshop(workerResults);

    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(200);
    expect(summary).toContain("# Feedback Workshop Findings Summary");
  });

  it("2. includes all 3 worker sections in output", () => {
    const summary = finalizeFeedbackWorkshop(workerResults);

    expect(summary).toContain("Cost Auditor");
    expect(summary).toContain("Spec Finder");
    expect(summary).toContain("Friction Detector");
  });

  it("3. includes all worker findings with verdict + reference", () => {
    const summary = finalizeFeedbackWorkshop(workerResults);

    expect(summary).toContain("Task cost is high");
    expect(summary).toContain("scorecard.json: cost=$100");
    expect(summary).toContain("Success criterion is vague");
  });

  it("4. includes reviewer validations", () => {
    const summary = finalizeFeedbackWorkshop(workerResults);

    expect(summary).toContain("Reviewer Validation");
  });

  it("5. shows reviewer verdict for each finding", () => {
    const summary = finalizeFeedbackWorkshop(workerResults);

    // Should indicate which findings were supported, refuted, or qualified
    expect(summary).toContain("SUPPORT");
    expect(summary).toContain("REFUTE");
  });

  it("6. includes refinements from reviewer", () => {
    const summary = finalizeFeedbackWorkshop(workerResults);

    expect(summary).toContain("Refinements:");
  });

  it("7. is valid markdown with structure", () => {
    const summary = finalizeFeedbackWorkshop(workerResults);

    // Should have headings and bullets
    expect(summary).toContain("#");
    expect(summary).toContain("-");
  });

  it("8. includes summary statistics", () => {
    const summary = finalizeFeedbackWorkshop(workerResults);

    // Should have Summary section with stats
    expect(summary).toContain("## Summary");
    expect(summary).toContain("Total Findings");
  });
});
