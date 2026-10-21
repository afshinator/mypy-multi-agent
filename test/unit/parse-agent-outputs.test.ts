/**
 * #93: Parse agent outputs and build FeedbackWorkerResult
 * Agents return JSON with findings[]. Parse, validate, and convert to schema.
 */
import { describe, it, expect } from "vitest";
import { parseAgentOutput } from "../../src/supervisor/parse-agent-outputs";

describe("parse-agent-outputs (#93)", () => {
  const validOutput = {
    findings: [
      {
        verdict: "Cost is high",
        severity: "HIGH",
        reference: "scorecard.json: cost=$100",
        reasoning: "Above peer average",
        confidence: "HIGH",
      },
    ],
    summary: "Found 1 cost anomaly",
  };

  it("1. exports parseAgentOutput function", () => {
    expect(typeof parseAgentOutput).toBe("function");
  });

  it("2. parses valid JSON agent output", () => {
    const result = parseAgentOutput("cost-auditor", JSON.stringify(validOutput));

    expect(result).toBeDefined();
    expect(result.agent).toBe("cost-auditor");
    expect(result.findings).toHaveLength(1);
  });

  it("3. validates mandatory finding fields", () => {
    const result = parseAgentOutput("cost-auditor", JSON.stringify(validOutput));

    expect(result.findings.length).toBeGreaterThan(0);
    const finding = result.findings[0];
    expect(finding).toBeDefined();
    expect(finding!.reference).toBeDefined();
    expect(finding!.reference.length).toBeGreaterThan(0);
    expect(finding!.reasoning).toBeDefined();
    expect(finding!.reasoning.length).toBeGreaterThan(0);
  });

  it("4. enforces reference + reasoning are not empty", () => {
    const invalidOutput = {
      findings: [
        {
          verdict: "Test",
          severity: "HIGH",
          reference: "",
          reasoning: "",
          confidence: "HIGH",
        },
      ],
      summary: "Test",
    };

    expect(() => {
      parseAgentOutput("cost-auditor", JSON.stringify(invalidOutput));
    }).toThrow();
  });

  it("5. handles missing JSON gracefully", () => {
    expect(() => {
      parseAgentOutput("cost-auditor", "not json");
    }).toThrow();
  });

  it("6. handles missing findings array", () => {
    expect(() => {
      parseAgentOutput("cost-auditor", JSON.stringify({ summary: "no findings" }));
    }).toThrow();
  });

  it("7. accepts empty findings array", () => {
    const output = { findings: [], summary: "No findings" };
    const result = parseAgentOutput("cost-auditor", JSON.stringify(output));

    expect(result.findings).toHaveLength(0);
    expect(result.summary).toBe("No findings");
  });

  it("8. includes all finding fields in output", () => {
    const result = parseAgentOutput("cost-auditor", JSON.stringify(validOutput));

    expect(result.findings.length).toBeGreaterThan(0);
    const finding = result.findings[0];
    expect(finding).toBeDefined();
    expect(finding!.verdict).toBeDefined();
    expect(finding!.severity).toBeDefined();
    expect(finding!.reference).toBeDefined();
    expect(finding!.reasoning).toBeDefined();
    expect(finding!.confidence).toBeDefined();
    expect(["HIGH", "MEDIUM", "LOW"]).toContain(finding!.severity);
    expect(["HIGH", "MEDIUM", "LOW"]).toContain(finding!.confidence);
  });
});
