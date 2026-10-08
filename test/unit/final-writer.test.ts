/**
 * Unit tests for the final writer module.
 */
import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalWriter } from "../../src/artifacts/final-writer";
import { EXIT } from "../../src/runtime/exit";

describe("FinalWriter", () => {
  it("writes final.md (decision) and findings.md (raw reports)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({
        outcome: "success",
        exitCode: EXIT.SUCCESS,
        reports: [
          { agentId: "a", report: "report from a" },
          { agentId: "b", report: "report from b" },
        ],
        decision: "S1: dev_b was right; adopted its simpler fix.",
      });
      const final = await readFile(join(dir, "final.md"), "utf8");
      expect(final).toContain("status: success");
      expect(final).toContain("exit_code: 0");
      expect(final).toContain("## Decision");
      expect(final).toContain("dev_b was right");
      expect(final).toContain("findings.md");
      expect(final).not.toContain("## a\n");
      const findings = await readFile(join(dir, "findings.md"), "utf8");
      expect(findings).toContain("## a");
      expect(findings).toContain("report from b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("notes a missing decision and still writes findings.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({ outcome: "aborted", exitCode: 2, reports: [] });
      expect(await readFile(join(dir, "final.md"), "utf8")).toContain("_(not recorded");
      expect(await readFile(join(dir, "findings.md"), "utf8")).toContain("_(none)_");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders the cost breakdown in frontmatter when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({
        outcome: "success",
        exitCode: EXIT.SUCCESS,
        reports: [{ agentId: "a", report: "report from a" }],
        costs: {
          supervisorCostUsd: 1.25,
          supervisorTokens: 5000,
          agents: [{ name: "a", costUsd: 0.4, tokens: 1200 }],
          totalCostUsd: 1.65,
          totalTokens: 6200,
        },
      });
      const content = await readFile(join(dir, "final.md"), "utf8");
      expect(content).toContain("total_cost_usd: 1.65");
      expect(content).toContain("total_tokens: 6200");
      expect(content).toContain("supervisor_cost_usd: 1.25");
      expect(content).toContain("supervisor_tokens: 5000");
      expect(content).toContain("- name: a");
      expect(content).toContain("cost_usd: 0.4");
      expect(content).toContain("tokens: 1200");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
