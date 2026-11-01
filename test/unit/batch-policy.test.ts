import { describe, expect, it } from "vitest";
import { parsePolicy } from "../../src/batch/policy";

const POLICY = `version: 1
prepare:
  kinds: [code-fix]
  kind_templates:
    code-fix: templates/batch-code-fix.yaml
  triage_model: deepseek/deepseek-v4-pro
  verifier_model: openrouter/openai/gpt-6-luna
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
    expect(policy.prepare.verifierModel).toBe("openrouter/openai/gpt-6-luna");
    expect(policy.run.timeoutMinutes).toBe(30);
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
    expect(() =>
      parsePolicy(POLICY.replace("openrouter/openai/gpt-6-luna", "/gpt-6-luna")),
    ).toThrow(/verifier_model/);
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
