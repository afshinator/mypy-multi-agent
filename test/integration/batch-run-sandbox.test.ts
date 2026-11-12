/**
 * The run's sandbox, asserted by running in it (#489). The measured fact this test exists for: a
 * worktree's `.git` is a *file* pointing at `<repo>/.git/worktrees/<slug>`, so a commit writes into
 * the main repository, not the worktree. A profile that opens only the worktree breaks every commit.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentConfigDir,
  gitDirOf,
  sandboxAvailable,
  sandboxProfile,
} from "../../src/batch/sandbox";

const HOME_ROOT = "/Users/Shared";

/**
 * A batch's own suite runs confined, and the profile denies `/Users/Shared`, so this fixture cannot
 * exist there. The cause is printed so an unexpected error is visible instead of looking like a
 * normal skip.
 */
const fixtureBlocked: string | undefined = !sandboxAvailable()
  ? undefined
  : (() => {
      try {
        rmSync(mkdtempSync(join(HOME_ROOT, "mypi-run-sb-probe-")), {
          recursive: true,
          force: true,
        });
        return undefined;
      } catch (error) {
        return String(error);
      }
    })();
if (fixtureBlocked !== undefined) {
  console.warn(`batch-run-sandbox: the fixture cannot be created, skipping: ${fixtureBlocked}`);
}

const macOnly = sandboxAvailable() && fixtureBlocked === undefined ? it : it.skip;

let root: string;
let repo: string;
let worktree: string;
let home: string;
let configDir: string;
let profile: string;

const git = (args: string[], cwd: string) =>
  spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

/** One shell command inside the sandbox, in the worktree. */
const sandboxed = (command: string) =>
  spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", command], {
    cwd: worktree,
    encoding: "utf8",
  });

beforeAll(() => {
  if (!sandboxAvailable()) return;
  root = mkdtempSync(join(tmpdir(), "mypi-run-sb-"));
  repo = join(root, "repo");
  worktree = join(root, "wt");
  home = mkdtempSync(join(HOME_ROOT, "mypi-run-sb-home-"));
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "secret\n");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(["add", "."], repo);
  git(["commit", "-qm", "base"], repo);
  git(["worktree", "add", "-q", worktree, "-b", "run-sb"], repo);
  configDir = agentConfigDir(join(home, ".pi-agent-missing"));
  const gitDir = gitDirOf(worktree);
  profile = sandboxProfile({ clone: worktree, configDir, home, ...(gitDir ? { gitDir } : {}) });
});

afterAll(() => {
  if (!sandboxAvailable()) return;
  spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo, encoding: "utf8" });
  for (const dir of [home, configDir, root]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("the run's sandbox (#489)", () => {
  macOnly("finds the repository's git dir, not just the worktree", () => {
    // Without this, `git commit` fails with `Unable to create .../index.lock: Operation not permitted`.
    // git writes the canonical path, which on macOS resolves /var to /private/var.
    expect(gitDirOf(worktree)).toBe(realpathSync(join(repo, ".git")));
    expect(gitDirOf(repo)).toBe(join(repo, ".git"));
    expect(gitDirOf(mkdtempSync(join(tmpdir(), "mypi-not-a-repo-")))).toBeUndefined();
  });

  macOnly("lets a run's agent edit and commit in its worktree", () => {
    const result = sandboxed(
      "echo changed > README.md && git add README.md && git commit -qm work",
    );

    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
    const log = git(["log", "--oneline", "-1"], worktree);
    expect(log.stdout).toContain("work");
  });

  macOnly("refuses a write outside the worktree and the repository", () => {
    const result = sandboxed(`echo leaked > "${home}/probe.txt"`);

    expect(result.status).not.toBe(0);
    expect(existsSync(join(home, "probe.txt"))).toBe(false);
  });

  macOnly("refuses a read of the operator's ssh keys", () => {
    const result = sandboxed(`cat "${home}/.ssh/id_ed25519"`);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Operation not permitted");
  });
});
