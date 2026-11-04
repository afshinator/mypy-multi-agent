import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitWorktree,
  createWorktree,
  installManifest,
  removeWorktree,
  worktreePath,
} from "../../src/batch/worktree";

let root: string;
const MANIFEST = "version: '1.2'\nsession:\n  id: b-b9-t164\n";

/**
 * Git exports `GIT_DIR`/`GIT_WORK_TREE` to hooks, and `.githooks/pre-push` runs
 * `bun run check`. Inheriting them makes these throwaway repos operate on the real
 * checkout: it re-inits it (core.bare=true) and commits an empty tree over the branch
 * that was being pushed. Every git call here starts from a clean environment.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  return env;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mypi-worktree-"));
  git(["init", "-q", "-b", "main"], root);
  writeFileSync(join(root, "package.json"), "{}\n");
  // Mirrors this repo: a directory rule, which is what a symlink does not satisfy.
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "web", ".gitignore"), "node_modules/\n");
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "web", "node_modules"), { recursive: true });
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], root);
});

afterEach(() => {
  for (const dir of [worktreePath(root, "b-b9-t164"), worktreePath(root, "b-b9-t165")]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  rmSync(root, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("creates the branch from main at the just-prep path, with both module links", async () => {
    const worktree = await createWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });

    expect(worktree.path).toBe(join(root, "..", "ma-wt-b-b9-t164"));
    expect(worktree.branch).toBe("task/b-b9-t164");
    expect(git(["branch", "--show-current"], worktree.path).trim()).toBe("task/b-b9-t164");
    expect(readFileSync(join(worktree.path, "package.json"), "utf8")).toBe("{}\n");

    // Copied, not symlinked: `.gitignore` lists `node_modules/` (a directory rule), so a
    // symlinked node_modules is untracked, not ignored — which leaves the worktree dirty and
    // fails `bun run check` on the antislop scope test.
    expect(lstatSync(join(worktree.path, "node_modules")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(worktree.path, "web", "node_modules")).isDirectory()).toBe(true);
    expect(git(["status", "--porcelain"], worktree.path).trim()).toBe("");
    expect(git(["check-ignore", "node_modules"], worktree.path).trim()).toBe("node_modules");
  });

  it("refuses to reuse an existing worktree instead of adopting it", async () => {
    await createWorktree({ repoRoot: root, taskDir: "mypi-tasks", slug: "b-b9-t164" });

    await expect(
      createWorktree({ repoRoot: root, taskDir: "mypi-tasks", slug: "b-b9-t164" }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses to run from inside a worktree", async () => {
    const worktree = await createWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });

    await expect(
      createWorktree({ repoRoot: worktree.path, taskDir: "mypi-tasks", slug: "b-b9-t165" }),
    ).rejects.toThrow(/main checkout/);
  });
});

describe("isolation from a hook environment", () => {
  it("ignores an inherited GIT_DIR instead of operating on the real checkout", async () => {
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = "/nonexistent/gitdir";
    process.env.GIT_WORK_TREE = "/nonexistent/worktree";
    try {
      const worktree = await createWorktree({
        repoRoot: root,
        taskDir: "mypi-tasks",
        slug: "b-b9-t164",
      });
      expect(git(["branch", "--show-current"], worktree.path).trim()).toBe("task/b-b9-t164");
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.tree;
    }
  });
});

describe("installManifest", () => {
  it("writes session.yaml where the runtime resolves it", async () => {
    const worktree = await createWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });

    const path = installManifest({
      worktree: worktree.path,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
      manifestText: MANIFEST,
    });

    expect(path).toBe(join(worktree.path, "mypi-tasks", "b-b9-t164", "session.yaml"));
    expect(readFileSync(path, "utf8")).toBe(MANIFEST);
  });
});

describe("removeWorktree", () => {
  it("removes the checkout and keeps the branch it was on", async () => {
    const worktree = await createWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });
    expect(existsSync(worktree.path)).toBe(true);

    await removeWorktree({ repoRoot: root, slug: "b-b9-t164" });

    expect(existsSync(worktree.path)).toBe(false);
    // The branch is the deliverable: it survives while the checkout does not.
    expect(git(["branch", "--list", "task/b-b9-t164"], root).trim()).toContain("task/b-b9-t164");
    expect(git(["worktree", "list", "--porcelain"], root)).not.toContain("ma-wt-b-b9-t164");
  });

  it("does nothing when the worktree is already gone", async () => {
    await expect(removeWorktree({ repoRoot: root, slug: "b-b9-t164" })).resolves.toBeUndefined();
  });
});

describe("commitWorktree", () => {
  it("commits uncommitted work onto the branch", async () => {
    const worktree = await createWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });
    writeFileSync(join(worktree.path, "change.txt"), "implementer work\n");

    const { commits } = await commitWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });

    // The branch carries the work; the worktree is clean afterwards.
    expect(commits).toBe(1);
    expect(git(["log", "--oneline", "task/b-b9-t164"], root)).toContain("mypi-batch: b-b9-t164");
    expect(git(["status", "--porcelain"], worktree.path).trim()).toBe("");
  });

  it("is a no-op on a clean worktree, and reports no commits", async () => {
    await createWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });

    const { commits } = await commitWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });

    // No new commit: the branch tip is still the base.
    expect(commits).toBe(0);
    expect(git(["log", "--oneline", "-1", "task/b-b9-t164"], root).trim()).toContain("init");
  });

  it("leaves the run's own manifest out of the commit (#299)", async () => {
    const worktree = await createWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });
    // What the executor writes before the run starts: run metadata, not implementer work.
    installManifest({
      worktree: worktree.path,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
      manifestText: MANIFEST,
    });

    const { commits } = await commitWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });

    // The only change was the manifest, so the branch is still empty: a zero-diff run
    // must not look like it produced a delivery (#289).
    expect(commits).toBe(0);
    expect(existsSync(join(worktree.path, "mypi-tasks", "b-b9-t164", "session.yaml"))).toBe(true);
  });

  it("commits implementer work while leaving the manifest out", async () => {
    const worktree = await createWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });
    installManifest({
      worktree: worktree.path,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
      manifestText: MANIFEST,
    });
    writeFileSync(join(worktree.path, "change.txt"), "implementer work\n");

    const { commits } = await commitWorktree({
      repoRoot: root,
      taskDir: "mypi-tasks",
      slug: "b-b9-t164",
    });

    expect(commits).toBe(1);
    expect(git(["show", "--name-only", "--format=", "task/b-b9-t164"], root)).toBe("change.txt\n");
  });
});
