/**
 * Analysis task modules, tested against the real run directories in mypi-tasks/.
 *
 * No synthetic fixtures: the point of these modules is that they survive the
 * artifacts that actually exist, including the ones that are missing.
 */
import { describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import { finalizeAnalysis } from "../../src/supervisor/analysis-finalization";
import {
  buildAnalystWorkOrder,
  buildReviewerWorkOrder,
} from "../../src/supervisor/analysis-prompts";
import {
  EXPECTED_ARTIFACTS,
  renderTargetInventory,
  resolveAnalysisTargets,
} from "../../src/supervisor/analysis-targets";

const priced = () => false;

const baseConfig = () =>
  parseSessionConfig(
    {
      version: "1.2",
      session: {
        id: "post-mortem-test",
        role: "analysis",
        max_cost_usd: 2,
        agent_stop_threshold_percent: 85,
        attester: "reviewer",
        input_tasks: ["04-inspector-server", "r1-fixes"],
      },
      analyze: {
        title: "Post-mortem",
        success_criterion: "Find what wasted time and money",
      },
      agents: ["cost", "spec", "friction", "reviewer"].map((id) => ({
        id,
        title: id,
        model: "provider/model",
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: 1,
        system_prompt: `you are the ${id}`,
      })),
    },
    priced,
  );

describe("resolveAnalysisTargets", () => {
  it("resolves real run directories and inventories what is present", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });

    expect(targets.map((t) => t.id)).toEqual(["04-inspector-server", "r1-fixes"]);
    expect(targets[0]!.run_details_dir).toContain("04-inspector-server/run-details");

    const inspector = targets[0]!;
    expect(inspector.artifacts.map((a) => a.name)).toContain("spans.jsonl");
    expect(inspector.artifacts.every((a) => a.bytes > 0)).toBe(true);
  });

  it("reports spans.jsonl as missing on a run that predates tracing", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });
    const r1 = targets.find((t) => t.id === "r1-fixes")!;

    // r1-fixes has no spans.jsonl on disk; the inventory must say so rather
    // than leave the analyst to discover it.
    expect(r1.missing).toContain("spans.jsonl");
    expect(r1.artifacts.map((a) => a.name)).not.toContain("spans.jsonl");
    // ...while still having the artifacts it does have.
    expect(r1.artifacts.map((a) => a.name)).toContain("tool-calls.jsonl");
  });

  it("throws when a target has no run-details directory", () => {
    const config = baseConfig();
    (config.session as { input_tasks?: string[] }).input_tasks = [
      "04-inspector-server",
      "does-not-exist",
    ];
    expect(() => resolveAnalysisTargets(config, { taskDir: "mypi-tasks" })).toThrow(
      /run directory not found/,
    );
  });

  it("throws when the role is not analysis", () => {
    const config = baseConfig();
    (config.session as { role: string }).role = "standard";
    expect(() => resolveAnalysisTargets(config, { taskDir: "mypi-tasks" })).toThrow(
      /only for analysis role/,
    );
  });

  it("inventories every expected artifact either present or missing", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });
    for (const t of targets) {
      const accounted = [...t.artifacts.map((a) => a.name), ...t.missing].sort();
      expect(accounted).toEqual([...EXPECTED_ARTIFACTS].sort());
    }
  });
});

describe("renderTargetInventory", () => {
  it("prints directories, sizes and absences for the prompt", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });
    const text = renderTargetInventory(targets);

    expect(text).toContain("04-inspector-server");
    expect(text).toContain("spans.jsonl");
    expect(text).toContain("absent:");
    expect(text).toMatch(/\d+ bytes/);
  });
});

describe("buildAnalystWorkOrder", () => {
  const targets = () => resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });

  it("gives each analyst a distinct lens", () => {
    const a = buildAnalystWorkOrder(targets(), "crit", "cost");
    const b = buildAnalystWorkOrder(targets(), "crit", "friction");

    expect(a.action).not.toBe(b.action);
    expect(a.action).toContain("cost and time");
    expect(b.action).toContain("interaction");
  });

  it("carries the target directories and the success criterion", () => {
    const wo = buildAnalystWorkOrder(targets(), "Find what wasted time", "spec");

    expect(wo.action).toContain("04-inspector-server/run-details");
    expect(wo.action).toContain("r1-fixes/run-details");
    expect(wo.action).toContain("Find what wasted time");
  });

  it("demands a citation and allows non-prompt reactions", () => {
    const wo = buildAnalystWorkOrder(targets(), "crit", "cost");

    expect(wo.action).toMatch(/without a citation is not a finding/i);
    expect(wo.action).toMatch(/max_tokens/);
    expect(wo.localDoD).toMatch(/cites an artifact/i);
  });

  it("tells the analyst that an empty report is acceptable", () => {
    const wo = buildAnalystWorkOrder(targets(), "crit", "friction");
    expect(wo.action).toMatch(/empty report is a\s+valid result/i);
  });

  it("warns that spans.jsonl may be absent and names the fallback", () => {
    const wo = buildAnalystWorkOrder(targets(), "crit", "cost");
    expect(wo.action).toMatch(/spans\.jsonl only exists/i);
    expect(wo.action).toContain("tool-calls.jsonl");
  });
});

describe("buildReviewerWorkOrder", () => {
  it("embeds every analyst report and requires checking against files", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });
    const wo = buildReviewerWorkOrder(targets, "crit", [
      { analyst: "cost", report: "COST-REPORT-BODY" },
      { analyst: "spec", report: "SPEC-REPORT-BODY" },
      { analyst: "friction", report: "FRICTION-REPORT-BODY" },
    ]);

    expect(wo.action).toContain("COST-REPORT-BODY");
    expect(wo.action).toContain("SPEC-REPORT-BODY");
    expect(wo.action).toContain("FRICTION-REPORT-BODY");
    expect(wo.action).toMatch(/Is the observation there\?/);
    expect(wo.action).toMatch(/Does the interpretation overclaim\?/);
    expect(wo.action).toMatch(/does the proposed reaction address/i);
  });

  it("asks the reviewer to name cross-report agreement", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });
    const wo = buildReviewerWorkOrder(targets, "crit", [{ analyst: "cost", report: "a" }]);
    expect(wo.action).toMatch(/different angles/i);
  });
});

describe("finalizeAnalysis", () => {
  it("frames the post-mortem with what was examined and its absences", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });
    const md = finalizeAnalysis({
      targets,
      success_criterion: "Find what wasted time and money",
      analysts: [
        { analyst: "cost", report: "cost body" },
        { analyst: "spec", report: "spec body" },
        { analyst: "friction", report: "friction body" },
      ],
      reviewer: { report: "reviewer body" },
    });

    expect(md).toContain("# Post-mortem");
    expect(md).toContain("What was examined");
    expect(md).toContain("04-inspector-server");
    expect(md).toContain("absent:");
    expect(md).toContain("Find what wasted time and money");
    expect(md).toContain("cost body");
    expect(md).toContain("spec body");
    expect(md).toContain("friction body");
    expect(md).toContain("reviewer body");
  });

  it("marks an unreviewed post-mortem as unreviewed", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });
    const md = finalizeAnalysis({
      targets,
      success_criterion: "crit",
      analysts: [{ analyst: "cost", report: "only report" }],
    });

    expect(md).toMatch(/unreviewed/i);
    expect(md).toMatch(/_No report\._/);
  });

  it("records an analyst that never reported instead of dropping it", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });
    const md = finalizeAnalysis({
      targets,
      success_criterion: "crit",
      analysts: [{ analyst: "cost", report: "x" }],
      failures: [{ analyst: "friction", error: "peer crashed mid-turn" }],
    });

    expect(md).toContain("did not report");
    expect(md).toContain("peer crashed mid-turn");
  });

  it("tells the reader the reaction may not be a prompt change", () => {
    const targets = resolveAnalysisTargets(baseConfig(), { taskDir: "mypi-tasks" });
    const md = finalizeAnalysis({ targets, success_criterion: "c", analysts: [] });
    expect(md).toMatch(/config field, a model, or the shape of the work order/);
    expect(md).toMatch(/is not a defect in our prompt/i);
  });
});
