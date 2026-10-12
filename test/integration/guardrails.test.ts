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
