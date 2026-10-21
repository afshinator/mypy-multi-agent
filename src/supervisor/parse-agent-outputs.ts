/**
 * Parse agent JSON outputs and convert to AgentReport.
 * Validates Finding schema (reference + reasoning mandatory).
 */
import type { AgentReport, Finding } from "./dispatch-feedback-workers";

/**
 * Parse a single agent's JSON output.
 * Expected format: { findings: [...], summary: string }
 * @param agentName Agent identifier (cost-auditor, spec-finder, friction-detector)
 * @param output JSON string from agent
 * @returns AgentReport with findings validated
 * @throws Error if JSON invalid or schema violated
 */
export function parseAgentOutput(agentName: string, output: string): AgentReport {
  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Agent ${agentName} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Validate structure
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("findings" in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).findings)
  ) {
    throw new Error(`Agent ${agentName} output missing findings[] array`);
  }

  const data = parsed as Record<string, unknown>;
  const findings = data.findings as unknown[];
  const summary = typeof data.summary === "string" ? data.summary : "";

  // Validate each finding
  const validatedFindings: Finding[] = [];
  for (const f of findings) {
    if (!f || typeof f !== "object") {
      throw new Error(`Agent ${agentName} finding is not an object`);
    }

    const finding = f as Record<string, unknown>;
    const reference = String(finding.reference ?? "").trim();
    const reasoning = String(finding.reasoning ?? "").trim();

    // Mandatory fields
    if (!reference) {
      throw new Error(`Agent ${agentName} finding missing non-empty reference field`);
    }
    if (!reasoning) {
      throw new Error(`Agent ${agentName} finding missing non-empty reasoning field`);
    }

    validatedFindings.push({
      verdict: String(finding.verdict ?? ""),
      severity: (["HIGH", "MEDIUM", "LOW"].includes(String(finding.severity))
        ? String(finding.severity)
        : "MEDIUM") as "HIGH" | "MEDIUM" | "LOW",
      reference,
      reasoning,
      confidence: (["HIGH", "MEDIUM", "LOW"].includes(String(finding.confidence))
        ? String(finding.confidence)
        : "MEDIUM") as "HIGH" | "MEDIUM" | "LOW",
    });
  }

  return {
    agent: agentName,
    findings: validatedFindings,
    summary,
  };
}
