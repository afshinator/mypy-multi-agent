/**
 * Unit tests for the batch manifest builder: one validated session.yaml from a
 * template plus an accepted ask. The YAML round trip is the guard — naive
 * emission turns `- Fix: it works` into a map, `- #1 priority` into null and
 * `- - dash` into a nested array (src/contracts/session-schema.ts, AskSchema).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildManifestText } from "../../src/batch/manifest";
import { parseSessionConfig } from "../../src/contracts/session-schema";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const templateText = readFileSync(resolve(repoRoot, "templates/code-fix.yaml"), "utf8");

const ask = {
  title: "Fold the closing record into the gate",
  description: "Move the closing sequence into one owner.",
  definition_of_done: ["The closing sequence has one owner.", "`bun run check` exits 0."],
};

const build = (overrides: Partial<Parameters<typeof buildManifestText>[0]> = {}) =>
  buildManifestText({ templateText, ask, sessionId: "b-2026-11-01-a-t163", ...overrides });

const validate = (text: string) => parseSessionConfig(parse(text), () => false);

describe("buildManifestText", () => {
  it("validates and keeps everything the template decided", () => {
    const manifest = validate(build());
    expect(manifest.session.id).toBe("b-2026-11-01-a-t163");
    expect(manifest.session.attester).toBe("reviewer");
    expect(manifest.session.max_cost_usd).toBe(10);
    expect(manifest.agents.map((a) => a.id)).toEqual(["reviewer", "fixer"]);
    expect(manifest.ask).toEqual(ask);
  });

  it("survives YAML-hostile criteria byte-identically", () => {
    const hostile = [
      "- Fix: it works",
      "#1 priority is speed",
      "- - dash start",
      "* star start",
      "a: b, c",
      "\"quoted\" and 'single'",
      "50% faster",
      "2026-01-01",
      "yes",
    ];
    const manifest = validate(build({ ask: { ...ask, definition_of_done: hostile } }));
    expect(manifest.ask.definition_of_done).toEqual(hostile);
  });

  it("throws with the validator's message when the template is not launchable", () => {
    const broken = templateText.replace('attester: "reviewer"', 'attester: "nobody"');
    expect(() => build({ templateText: broken })).toThrow(/not a configured agent id/);
  });

  it("throws when the ask has no criteria", () => {
    expect(() => build({ ask: { ...ask, definition_of_done: [] } })).toThrow(/definition_of_done/);
  });

  it("throws when the template has no session block", () => {
    expect(() => build({ templateText: "version: '1.2'\n" })).toThrow(/session block/);
  });

  it("does not mutate the ask it is given", () => {
    const frozen = Object.freeze({
      ...ask,
      definition_of_done: Object.freeze([...ask.definition_of_done]),
    });
    expect(() => build({ ask: frozen as unknown as typeof ask })).not.toThrow();
    expect(frozen.definition_of_done).toEqual(ask.definition_of_done);
  });
});
