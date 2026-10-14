/**
 * Guardrails over shipped artifacts: every templates/**\/*.yaml parses against
 * the session contract with a non-empty DoD and no unresolved model placeholder
 * (unless verify_models: strict is set), and every relative Markdown link in
 * README.md / docs/*.md that stays inside the repo resolves to a real file.
 */

import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseSessionConfig } from "../../src/contracts/session-schema";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const isFreeModel = () => false; // pricing is runtime state; forcing it false keeps the free-model rule quiet

const templatePaths = globSync("templates/**/*.yaml", { cwd: repoRoot }).sort();
const markdownSources = [
  "README.md",
  ...readdirSync(join(repoRoot, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f)),
];

// Skip targets that are not repo files: anchors, absolute paths, URL schemes.
const skip = (target: string) =>
  target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target);

const inRepo = (abs: string) => abs === repoRoot || abs.startsWith(repoRoot + sep);

// A link is checkable only if it resolves to a path inside the repo: `../` is
// relative to the linking file, so ../README.md from docs/ stays in the repo,
// while ../model-catalog.md from the root is a sibling checkout and is skipped.
function inRepoLinks(source: string): { target: string; abs: string }[] {
  const body = readFileSync(join(repoRoot, source), "utf8");
  const links: { target: string; abs: string }[] = [];
  for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]?.split("#")[0]?.split("?")[0];
    if (!target || skip(target)) continue;
    const abs = resolve(repoRoot, dirname(source), target);
    if (inRepo(abs)) links.push({ target, abs });
  }
  return links;
}

describe("templates", () => {
  it.each(templatePaths)("%s parses with a non-empty DoD and no placeholder model", (path) => {
    const config = parseSessionConfig(
      parse(readFileSync(join(repoRoot, path), "utf8")),
      isFreeModel,
    );

    expect(config.ask.definition_of_done.length).toBeGreaterThan(0);
    if (config.session.verify_models !== "strict") {
      expect(config.agents.filter((a) => /^REPLACE\//.test(a.model))).toEqual([]);
    }
  });
});

// The quality duties must survive every entry point. The default supervisor prompt
// (`src/pi/supervisor-prompt.md`) covers any task that does not override it, and a
// template that DOES override it must carry the same duties or the override silently
// drops them — which is how both went missing before this test existed.
// `src/pi/extension.ts` loads the default prompt; the tokens asserted here are the
// ones the peers are told to act on, not decoration.
const qualityDuty = (text: string) => ({
  ponytailSkill: text.includes("`ponytail` skill") && /level `full`/.test(text),
  reconciliation: text.includes("ponytail-review.md"),
  // A read-only reviewer cannot write the ledger, so the duty must say who does.
  transcription: text.includes("transcribes it verbatim"),
  lintFormat: /lint\/format/i.test(text),
});

describe("quality duties (ponytail + lint/format)", () => {
  const defaultPrompt = readFileSync(join(repoRoot, "src/pi/supervisor-prompt.md"), "utf8");

  it("the default supervisor prompt carries them", () => {
    expect(qualityDuty(defaultPrompt)).toEqual({
      ponytailSkill: true,
      reconciliation: true,
      transcription: true,
      lintFormat: true,
    });
  });

  const overriding = templatePaths.filter((path) => {
    const config = parse(readFileSync(join(repoRoot, path), "utf8"));
    const prompt = config?.session?.supervisor_system_prompt;
    return typeof prompt === "string" && prompt.length > 0;
  });

  // Guards the filter: if every template stopped overriding, the cases below would
  // vanish and prove nothing.
  it("finds template overrides to check", () => {
    expect(overriding.length).toBeGreaterThan(0);
  });

  it.each(overriding)("%s carries them in its supervisor prompt", (path) => {
    const prompt = parse(readFileSync(join(repoRoot, path), "utf8")).session
      .supervisor_system_prompt as string;
    expect(qualityDuty(prompt)).toEqual({
      ponytailSkill: true,
      reconciliation: true,
      transcription: true,
      lintFormat: true,
    });
  });
});

// RT-8: the diverge-and-defend DoD must be backed by the vocabulary that makes a
// round cost something — a pre-registered falsifier, labelled evidence classes,
// and the attester marker. Guards that the prompt and the DoD cannot drift apart.
describe("spec-plan-adversarial hardening (RT-8)", () => {
  const raw = readFileSync(join(repoRoot, "templates/spec-plan-adversarial.yaml"), "utf8");
  const config = parseSessionConfig(parse(raw), isFreeModel);

  it("carries a diverge-and-defend DoD criterion", () => {
    expect(config.ask.definition_of_done.join(" ")).toMatch(/falsifier|opposition/i);
  });

  it.each(["FALSIFIER", "FALSIFIER RESULT", "exec-here", "citation", "reasoned", "ATTESTER:"])(
    "prompt supplies the vocabulary token %s",
    (token) => {
      expect(raw).toContain(token);
    },
  );
});

describe("Markdown links", () => {
  it.each(markdownSources)("%s has only resolving in-repo relative links", (source) => {
    for (const { target, abs } of inRepoLinks(source)) {
      expect(existsSync(abs), `${source} -> ${target}`).toBe(true);
    }
  });

  // Guards the filter above: if every link is skipped, the tests above prove nothing.
  it("finds at least one in-repo relative link to check", () => {
    expect(markdownSources.flatMap(inRepoLinks).length).toBeGreaterThan(0);
  });
});
