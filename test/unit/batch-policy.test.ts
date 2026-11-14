import { describe, expect, it } from "vitest";
import { parsePolicy } from "../../src/batch/policy";

const POLICY = `version: 1
prepare:
  kinds: [code-fix]
  kind_templates:
    code-fix: templates/batch-code-fix.yaml
  triage_model: deepseek/deepseek-v4-pro
  verifier_model: commandcode/gpt-6-luna
  agent_timeout_minutes: 30
run:
  timeout_minutes: 30
`;

describe("parsePolicy", () => {
  it("reads the policy", () => {
    const policy = parsePolicy(POLICY);

    expect(policy.prepare.kinds).toEqual(["code-fix"]);
    expect(policy.prepare.kindTemplates).toEqual({ "code-fix": "templates/batch-code-fix.yaml" });
    expect(policy.prepare.triageModel).toBe("deepseek/deepseek-v4-pro");
    expect(policy.prepare.verifierModel).toBe("commandcode/gpt-6-luna");
    expect(policy.run.timeoutMinutes).toBe(30);
  });

  it("defaults refuse_blocked off, and reads true when set", () => {
    expect(parsePolicy(POLICY).prepare.refuseBlocked).toBe(false);
    expect(
      parsePolicy(
        POLICY.replace(
          "agent_timeout_minutes: 30",
          "agent_timeout_minutes: 30\n  refuse_blocked: true",
        ),
      ).prepare.refuseBlocked,
    ).toBe(true);
  });

  it("defaults every label, so a policy written before labels keeps working (#502)", () => {
    const policy = parsePolicy(POLICY);

    expect(policy.labels).toEqual({
      ready: "ready-for-agent",
      needsInfo: "needs-info",
      skipped: "not-batched",
      human: "ready-for-human",
      onRefusal: false,
    });
  });

  it("reads a repository's own label names and opts in to moving one (#502)", () => {
    const policy = parsePolicy(
      `${POLICY}labels:
  ready: afk-ready
  needs_info: awaiting-info
  skipped: no-batch
  human: human-only
  on_refusal: true
`,
    );

    expect(policy.labels).toEqual({
      ready: "afk-ready",
      needsInfo: "awaiting-info",
      skipped: "no-batch",
      human: "human-only",
      onRefusal: true,
    });
  });

  it("refuses a blank label and a non-boolean opt-in", () => {
    expect(() => parsePolicy(`${POLICY}labels:\n  ready: ""\n`)).toThrow(/labels.ready/);
    expect(() => parsePolicy(`${POLICY}labels:\n  on_refusal: yes please\n`)).toThrow(
      /labels.on_refusal/,
    );
  });

  it("refuses an unknown version", () => {
    expect(() => parsePolicy(POLICY.replace("version: 1", "version: 2"))).toThrow(/version/);
  });

  it("refuses a kind with no template, and a template with no kind", () => {
    expect(() =>
      parsePolicy(
        POLICY.replace(/^ {2}kind_templates:\n {4}code-fix: .*$/m, "  kind_templates: {}"),
      ),
    ).toThrow(/no template for kind "code-fix"/);
    expect(() =>
      parsePolicy(
        POLICY.replace("    code-fix: templates/batch-code-fix.yaml", "    typo: templates/x.yaml"),
      ),
    ).toThrow(/template for unknown kind "typo"/);
  });

  it("refuses duplicate kinds and an empty kind list", () => {
    expect(() =>
      parsePolicy(POLICY.replace("kinds: [code-fix]", "kinds: [code-fix, code-fix]")),
    ).toThrow(/duplicate kind/);
    expect(() => parsePolicy(POLICY.replace("kinds: [code-fix]", "kinds: []"))).toThrow(
      /at least one kind/,
    );
  });

  it("refuses a model that is not provider/model", () => {
    expect(() =>
      parsePolicy(POLICY.replace("deepseek/deepseek-v4-pro", "deepseek-v4-pro")),
    ).toThrow(/triage_model/);
    expect(() => parsePolicy(POLICY.replace("commandcode/gpt-6-luna", "/gpt-6-luna"))).toThrow(
      /verifier_model/,
    );
  });

  it("refuses a non-positive or non-numeric timeout", () => {
    expect(() =>
      parsePolicy(POLICY.replace("\nrun:\n  timeout_minutes: 30", "\nrun:\n  timeout_minutes: 0")),
    ).toThrow(/run.timeout_minutes/);
    expect(() =>
      parsePolicy(POLICY.replace("agent_timeout_minutes: 30", 'agent_timeout_minutes: "soon"')),
    ).toThrow(/agent_timeout_minutes/);
  });

  it("refuses a document that is not a mapping", () => {
    expect(() => parsePolicy("- just\n- a list\n")).toThrow(/mapping/);
  });
});
