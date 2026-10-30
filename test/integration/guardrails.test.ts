/**
 * Guardrails over shipped artifacts: every runnable templates/**\/*.yaml parses
 * against the session contract with a non-empty DoD and no unresolved model
 * placeholder (unless verify_models: strict is set); every relative Markdown link
 * in README.md / docs/**\/*.md that stays inside the repo resolves to a real
 * file; and every documented code citation — `src/x.ts#symbol` or
 * `src/x.ts:symbol` — names a file that exists with a symbol that grep-matches
 * inside it. The citation check is existence-only: a symbol cited under the
 * wrong file, a stale line number, or a path belonging to another checkout all
 * still pass. Every `docs/adr/*.md` must also be listed in `docs/adr/README.md`,
 * so the index cannot drift from the directory. `templates/starter.yaml` is
 * exempt from the parse check: it is a
 * keys-only form dropped by `/mypi-multi-agent --init`, not a runnable config.
 */

import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseSessionConfig } from "../../src/contracts/session-schema";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const isFreeModel = () => false; // pricing is runtime state; forcing it false keeps the free-model rule quiet

const templatePaths = globSync("templates/**/*.yaml", { cwd: repoRoot }).sort();
const markdownSources = ["README.md", ...globSync("docs/**/*.md", { cwd: repoRoot }).sort()];
const adrPaths = globSync("docs/adr/*.md", { cwd: repoRoot })
  .filter((path) => path !== "docs/adr/README.md")
  .sort();

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

describe("post-mortem prompt discipline (#121)", () => {
  // Both post-mortem runs failed criteria 3, 5 and 6 on the first attestation
  // round, and one failed criterion 1 because the supervisor invented a side
  // document and summarised it. These rules were implicit; they are now stated,
  // and this test fails if the statements are deleted.
  const config = parseSessionConfig(
    parse(readFileSync(join(repoRoot, "templates/post-mortem.yaml"), "utf8")),
    isFreeModel,
  );
  const supervisor = config.session.supervisor_system_prompt ?? "";
  const reviewer = config.agents.find((a) => a.id === config.session.attester)?.system_prompt ?? "";
  // The prompts are wrapped prose; assert on content, not on where the lines break.
  const flat = (s: string) => s.replace(/\s+/g, " ");

  it.each([
    ["one document and no side files", /no side file|any other file/i],
    ["the reports reproduced, not summarised", /reproduce/i],
    ["a concrete reaction for every outside-control item", /is not a reaction/i],
    ["the citation check run before attestation", /check-citations/i],
  ])("the supervisor prompt states %s", (_label, pattern) => {
    expect(flat(supervisor)).toMatch(pattern);
  });

  it.each([
    ["one disposition per finding, not a range", /not a range|one per finding/i],
    ["a concrete reaction for every outside-control item", /is not a reaction/i],
  ])("the reviewer prompt states %s", (_label, pattern) => {
    expect(flat(reviewer)).toMatch(pattern);
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

describe("writer prompt discipline (#130, #131)", () => {
  // The jev-c2-closeout writer rewrote both its own target files wholesale after
  // three edits missed. Its files were in scope, so the write-scope gate would
  // have allowed it: the rule has to live in the prompt, and it has to be the same
  // rule in every writer prompt or it drifts back out.
  const writerPrompts = templatePaths.flatMap((path) => {
    let agents: unknown;
    try {
      agents = (parse(readFileSync(join(repoRoot, path), "utf8")) as { agents?: unknown }).agents;
    } catch {
      return [];
    }
    if (!Array.isArray(agents)) return [];
    return (agents as { id?: unknown; permissions?: { edit?: unknown }; system_prompt?: unknown }[])
      .filter((a) => a.permissions?.edit === true)
      .map((a) => ({ path, id: String(a.id), prompt: String(a.system_prompt ?? "") }));
  });

  it("finds the writer peers it claims to guard", () => {
    expect(writerPrompts.length).toBeGreaterThanOrEqual(10);
  });

  it.each(writerPrompts)("$path $id forbids overwriting a whole file", ({ prompt }) => {
    expect(prompt).toContain("never overwrite it wholesale");
    expect(prompt).toContain("write` is for creating files that do not exist yet");
  });

  // The 04-inspector-server re-dispatch pinned DEFAULT_PROJECTS_DIR while its own
  // DoD forbade a hardcoded path, and the rework cost three dispatches.
  it("the supervisor brain says a work order may not name what the DoD forbids", () => {
    // Markdown wraps: compare with whitespace collapsed, or the guard breaks on a
    // line break rather than on a missing rule.
    const brain = readFileSync(join(repoRoot, "src/pi/supervisor-prompt.md"), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(brain).toContain("may not name a symbol, default or value");
    expect(brain).toContain("the criteria win");
  });

  // #132: the reviewer polled the full suite through a tree the fixers were still
  // editing, 25 times, and paid a turn for each red run. The policy belongs in the
  // brain or it is reinvented per run.
  it("the supervisor brain gives the full suite to the attester and names the focused form", () => {
    const brain = readFileSync(join(repoRoot, "src/pi/supervisor-prompt.md"), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(brain).toContain("full suite belongs to the attester");
    expect(brain).toContain("NOT `bun run test -- <path>`");
  });
});

describe("docs/adr index", () => {
  // AGENTS.md told agents for a while that docs/adr/ held no ADRs, which is
  // exactly how an ADR gets written and never read (retro S3).
  it.each(adrPaths)("%s is listed in docs/adr/README.md", (path) => {
    const index = readFileSync(join(repoRoot, "docs", "adr", "README.md"), "utf8");
    expect(index).toContain(path.replace("docs/adr/", ""));
  });

  it("has an ADR for every file in the directory", () => {
    expect(adrPaths.length).toBeGreaterThan(0);
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

// Issue #141: `main` is protected on the server, so a local push must be refused
// with a message that names the remedy GitHub's own refusal does not. The hook is
// pure `sh` and reads one line per pushed ref on stdin, so it can be driven
// directly: `bun` is faked on PATH to prove which branch of the guard ran.
describe("pre-push hook", () => {
  const hook = join(repoRoot, ".githooks", "pre-push");

  const runHook = (stdin: string) => {
    const dir = mkdtempSync(join(tmpdir(), "pre-push-"));
    const marker = join(dir, "check-ran");
    writeFileSync(join(dir, "bun"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`, {
      mode: 0o755,
    });
    const result = spawnSync("sh", [hook], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    return { ...result, checkRan: existsSync(marker) };
  };

  it("refuses a push to main and names the remedy", () => {
    const { status, stderr, checkRan } = runHook(
      "HEAD 1111111111111111111111111111111111111111 refs/heads/main 0000000000000000000000000000000000000000\n",
    );
    expect(status).toBe(1);
    expect(stderr).toContain("just land");
    expect(checkRan).toBe(false);
  });

  it("refuses when main is one ref among several", () => {
    const taskRef = `HEAD ${"1".repeat(40)} refs/heads/task/x ${"0".repeat(40)}`;
    const mainRef = `HEAD ${"2".repeat(40)} refs/heads/main ${"0".repeat(40)}`;
    const { status, stderr } = runHook(`${taskRef}\n${mainRef}\n`);
    expect(status).toBe(1);
    expect(stderr).toContain("just land");
  });

  it("runs the gate for a task branch", () => {
    const { status, checkRan } = runHook(
      "HEAD 1111111111111111111111111111111111111111 refs/heads/task/x 0000000000000000000000000000000000000000\n",
    );
    expect(status).toBe(0);
    expect(checkRan).toBe(true);
  });
});
