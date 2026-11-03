/**
 * The batch template must launch. `templates/review-and-improve-code.yaml` passes
 * `parseSessionConfig` while carrying three `REPLACE/with-a-real-model` slugs under
 * `verify_models: strict`, so "it validates" is not the property that matters: this
 * pins the shape the batch driver generates manifests from.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseSessionConfig } from "../../src/contracts/session-schema";

const text = readFileSync("templates/batch-code-fix.yaml", "utf8");
const config = parseSessionConfig(parse(text), () => false);

describe("templates/batch-code-fix.yaml", () => {
  it("parses as a session config", () => {
    expect(config.session.id).toBe("batch-code-fix");
  });

  it("has two implementers and one reviewer that attests", () => {
    const implementers = config.agents.filter((a) => a.permissions.edit);
    const reviewer = config.agents.find((a) => a.id === config.session.attester);

    expect(implementers).toHaveLength(2);
    for (const dev of implementers) {
      expect(dev.permissions.shell).toBe(true);
      expect(dev.max_cost_usd).toBeGreaterThan(0);
    }
    // An attester that can edit grades its own work.
    expect(reviewer?.permissions.edit).toBe(false);
    expect(reviewer?.permissions.read).toBe(true);
  });

  it("pins every model to a real, non-placeholder slug", () => {
    const slugs = [config.session.supervisor_model, ...config.agents.map((a) => a.model)].filter(
      (s): s is string => typeof s === "string",
    );

    expect(slugs.length).toBeGreaterThanOrEqual(3);
    for (const slug of slugs) {
      expect(slug).not.toMatch(/REPLACE|with-a-real-model|your-model/i);
      // provider/model, where the model may itself contain slashes.
      expect(slug).toMatch(/^[a-z][a-z0-9._-]*\/[A-Za-z0-9._/-]+$/);
    }
    // Two implementers on one model share one family's failure modes.
    expect(new Set(config.agents.map((a) => a.model)).size).toBe(config.agents.length);
  });

  it("names the repo's own gate as mechanical validation", () => {
    expect(config.validation?.commands).toEqual(["bun run check"]);
  });

  it("caps peer spend and leaves the supervisor additive", () => {
    expect(config.session.max_cost_usd).toBeGreaterThan(0);
    expect(config.session.attester).toBeTruthy();
  });

  // The finalize gate parses a fenced JSON block (`src/contracts/criteria.ts#parseCriteriaBlock`)
  // and rejects a count mismatch or a rephrased criterion. The attester prompt used to ask for
  // "an explicit attestation line", which no parser reads: a code-fix run would have failed at
  // the gate with a missing block. Never observed, because no code-fix manifest has ever run.
  it("tells the attester the block the gate parses, verbatim", () => {
    const attester =
      config.agents.find((a) => a.id === config.session.attester)?.system_prompt ?? "";
    for (const token of ["```json", '"criterion"', '"result"', '"evidence"', "verbatim"]) {
      expect(attester).toContain(token);
    }
    expect(attester).toMatch(/pass.*fail|`pass` or `fail`/i);
  });

  // §10.5's R3 (stakes and consumer): every peer states who reads its output and what breaks.
  it("gives every peer a stake, not just a duty", () => {
    for (const peer of config.agents) {
      expect(peer.system_prompt).toMatch(/run fails|reviewer rejects|gate rejects/i);
    }
  });

  // §10.4 puts implementers at 95–100; below that a module is cut off with work left.
  it("keeps the stop threshold where the guide puts implementers", () => {
    expect(config.session.agent_stop_threshold_percent).toBeGreaterThanOrEqual(95);
  });
});
