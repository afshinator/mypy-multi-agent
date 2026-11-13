import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLaunchPreconditions } from "../../src/pi/launch-preconditions";

let root: string;
let agentConfig: string;
const SLUG = "b1-t1";

function config(taskDirs = ["mypi-tasks"]): void {
  writeFileSync(join(root, "mypi-multi-agent.yaml"), `version: 1\ntaskDirs:\n  - ${taskDirs[0]}\n`);
}

function session(): void {
  mkdirSync(join(root, "mypi-tasks", SLUG), { recursive: true });
  writeFileSync(join(root, "mypi-tasks", SLUG, "session.yaml"), "version: '1.2'\n");
}

function settings(extensions: unknown): void {
  writeFileSync(join(agentConfig, "settings.json"), JSON.stringify({ extensions }));
}

const saved = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mypi-precond-"));
  agentConfig = mkdtempSync(join(tmpdir(), "mypi-precond-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentConfig;
});

afterEach(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
  rmSync(agentConfig, { recursive: true, force: true });
});

describe("#563: a launch names the input it is missing", () => {
  it("passes a repo whose config, session and registered extension are all there", () => {
    config();
    session();
    const extension = join(root, "extension.ts");
    writeFileSync(extension, "// entry\n");
    settings([extension]);

    expect(checkLaunchPreconditions({ repoRoot: root, slug: SLUG })).toEqual([]);
  });

  it("names the project config it cannot read", () => {
    settings([join(root, "extension.ts")]);
    writeFileSync(join(root, "extension.ts"), "// entry\n");

    const problems = checkLaunchPreconditions({ repoRoot: root, slug: SLUG });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(join(root, "mypi-multi-agent.yaml"));
  });

  it("names the session.yaml the run would have nothing to load without", () => {
    config();
    const extension = join(root, "extension.ts");
    writeFileSync(extension, "// entry\n");
    settings([extension]);

    const problems = checkLaunchPreconditions({ repoRoot: root, slug: SLUG });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(join(root, "mypi-tasks", SLUG, "session.yaml"));
  });

  it("names an explicit extension that is not on disk", () => {
    config();
    session();
    const missing = join(root, "absent.ts");

    const problems = checkLaunchPreconditions({ repoRoot: root, slug: SLUG, extension: missing });

    expect(problems).toEqual([`the extension pi must load is missing: ${missing}`]);
  });

  it("accepts an explicit extension that exists, whatever the operator's config says", () => {
    config();
    session();
    const extension = join(root, "extension.ts");
    writeFileSync(extension, "// entry\n");

    expect(checkLaunchPreconditions({ repoRoot: root, slug: SLUG, extension })).toEqual([]);
  });

  it("names the settings file when no extension is named and none would load", () => {
    config();
    session();
    settings([]);

    const problems = checkLaunchPreconditions({ repoRoot: root, slug: SLUG });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(join(agentConfig, "settings.json"));
  });

  it("ignores a registered extension that is itself gone", () => {
    config();
    session();
    settings([join(root, "removed.ts")]);

    const problems = checkLaunchPreconditions({ repoRoot: root, slug: SLUG });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(join(agentConfig, "settings.json"));
  });
});
