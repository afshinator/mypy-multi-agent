/**
 * Unit tests for the final writer module.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it("annotates an empty peer report in findings.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({
        outcome: "failure",
        exitCode: EXIT.FAILURE,
        reports: [
          { agentId: "data_git", report: "" },
          { agentId: "reviewer", report: "real findings" },
        ],
      });
      const findings = await readFile(join(dir, "findings.md"), "utf8");
      expect(findings).toContain("## data_git");
      expect(findings).toContain("_(empty report");
      expect(findings).toContain("real findings");
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

  it("rounds USD to two decimals in the frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({
        outcome: "success",
        exitCode: EXIT.SUCCESS,
        reports: [],
        costs: {
          supervisorCostUsd: 0.2953,
          supervisorTokens: 100,
          agents: [{ name: "data_git", costUsd: 1.198, tokens: 200 }],
          totalCostUsd: 2.3798,
          totalTokens: 300,
        },
      });
      const content = await readFile(join(dir, "final.md"), "utf8");
      expect(content).toContain("total_cost_usd: 2.38");
      expect(content).toContain("supervisor_cost_usd: 0.3");
      expect(content).toContain("cost_usd: 1.2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders a prominent total cost line under ## Summary when costs exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({
        outcome: "success",
        exitCode: EXIT.SUCCESS,
        reports: [],
        costs: {
          supervisorCostUsd: 0.1,
          supervisorTokens: 10,
          agents: [{ name: "a", costUsd: 0.88, tokens: 20 }],
          totalCostUsd: 0.98,
          totalTokens: 30,
        },
      });
      const content = await readFile(join(dir, "final.md"), "utf8");
      expect(content).toContain("## Summary");
      expect(content).toContain("**Total cost: $0.98** (peers $0.88, supervisor $0.10).");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses two-decimal rounding everywhere in final.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({
        outcome: "success",
        exitCode: EXIT.SUCCESS,
        reports: [],
        costs: {
          supervisorCostUsd: 0.2953,
          supervisorTokens: 100,
          agents: [{ name: "data_git", costUsd: 1.198, tokens: 200 }],
          totalCostUsd: 2.3798,
          totalTokens: 300,
        },
      });
      const content = await readFile(join(dir, "final.md"), "utf8");
      expect(content).not.toMatch(/\d\.\d{3,}/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders accomplished/left lists under ## Summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({
        outcome: "success",
        exitCode: EXIT.SUCCESS,
        reports: [],
        summary: {
          accomplished: ["closed the four DoD criteria"],
          left: ["nits N1-N5 documented"],
        },
      });
      const content = await readFile(join(dir, "final.md"), "utf8");
      expect(content).toContain("## Summary");
      expect(content).toContain("**Accomplished:**");
      expect(content).toContain("- closed the four DoD criteria");
      expect(content).toContain("**Left:**");
      expect(content).toContain("- nits N1-N5 documented");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders _(none recorded)_ for empty summary lists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({
        outcome: "success",
        exitCode: EXIT.SUCCESS,
        reports: [],
        summary: { accomplished: [], left: [] },
      });
      const content = await readFile(join(dir, "final.md"), "utf8");
      expect(content).toContain("**Accomplished:**");
      expect(content).toContain("- _(none recorded)_");
      expect(content).toContain("**Left:**");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits ## Summary when no costs and no summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({ outcome: "aborted", exitCode: 2, reports: [] });
      const content = await readFile(join(dir, "final.md"), "utf8");
      expect(content).not.toContain("## Summary");
      expect(content).toContain("## Decision");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
