/**
 * Guardrails over shipped artifacts: every runnable templates/**\/*.yaml parses
 * against the session contract with a non-empty DoD and no unresolved model
 * placeholder (unless verify_models: strict is set); every relative Markdown link
 * in README.md / docs/**\/*.md that stays inside the repo resolves to a real
 * file; and every documented code citation — `src/x.ts#symbol` or
 * `src/x.ts:symbol` — names a file that exists with a symbol that grep-matches
 * inside it. The citation check is existence-only: a symbol cited under the
 * wrong file, a stale line number, or a path belonging to another checkout all
 * still pass. `templates/starter.yaml` is exempt from the parse check: it is a
 * keys-only form dropped by `/mypi-multi-agent --init`, not a runnable config.
 */

import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseSessionConfig } from "../../src/contracts/session-schema";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const isFreeModel = () => false; // pricing is runtime state; forcing it false keeps the free-model rule quiet

const templatePaths = globSync("templates/**/*.yaml", { cwd: repoRoot }).sort();
const markdownSources = ["README.md", ...globSync("docs/**/*.md", { cwd: repoRoot }).sort()];

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

// Documented code citations, both spellings in use: `src/x.ts#symbol` and
// `src/x.ts:symbol`. Existence only, by design — see the header comment. The
// `[A-Za-z_]` after the separator keeps bare line numbers (`x.ts:422`) out.
const citationPattern =
  /\b((?:src|shared|test|templates)\/[A-Za-z0-9_./-]+?\.(?:ts|yaml|json))([:#])([A-Za-z_][A-Za-z0-9_]*)/g;

const citations = markdownSources.flatMap((source) =>
  readFileSync(join(repoRoot, source), "utf8")
    .split("\n")
    .flatMap((line, i) =>
      [...line.matchAll(citationPattern)].map((match) => {
        const [, file = "", , symbol = ""] = match;
        return { where: `${source}:${i + 1}`, file, symbol };
      }),
    ),
);

describe("template listings", () => {
  // Both lists had drifted: 5 of the 12 templates were missing from each, and README
  // claimed session.yaml shows "every field commented" while the guide named the one it
  // omits (#94). Enforced so the next template cannot ship unlisted.
  it.each(["README.md", "docs/agent-config-guide.md"])("%s lists every template", (source) => {
    const body = readFileSync(join(repoRoot, source), "utf8");
    const missing = templatePaths.filter((p) => !body.includes(`\`${p}\``));
    expect(missing).toEqual([]);
  });
});

describe("templates", () => {
  const runnableTemplates = templatePaths.filter((p) => p !== "templates/starter.yaml");
  it.each(runnableTemplates)("%s parses with a non-empty DoD and no placeholder model", (path) => {
    const config = parseSessionConfig(
      parse(readFileSync(join(repoRoot, path), "utf8")),
      isFreeModel,
    );

    expect(config.ask.definition_of_done.length).toBeGreaterThan(0);
    if (config.session.verify_models !== "strict") {
      expect(config.agents.filter((a) => /^REPLACE\//.test(a.model))).toEqual([]);
    }
  });

  it("starter.yaml is a keys-only form, not a runnable config", () => {
    const parsed = parse(readFileSync(join(repoRoot, "templates/starter.yaml"), "utf8")) as {
      version: unknown;
      ask: { title: unknown; definition_of_done: unknown };
    };
    expect(parsed.version).toBeNull();
    expect(parsed.ask.title).toBeNull();
    expect(parsed.ask.definition_of_done).toBeNull();
    expect(() =>
      parseSessionConfig(
        parse(readFileSync(join(repoRoot, "templates/starter.yaml"), "utf8")),
        isFreeModel,
      ),
    ).toThrow();
  });
});

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

describe("documented code citations", () => {
  it.each(citations)("$where cites a symbol that exists ($file#$symbol)", ({ file, symbol }) => {
    const abs = join(repoRoot, file);
    expect(existsSync(abs), `${file} does not exist`).toBe(true);
    expect(readFileSync(abs, "utf8")).toMatch(new RegExp(`\\b${symbol}\\b`));
  });

  // Guards the scan above: a rewritten pattern that matches nothing would make
  // the cases vacuous rather than failing.
  it("finds at least one documented citation to check", () => {
    expect(citations.length).toBeGreaterThan(0);
  });
});
