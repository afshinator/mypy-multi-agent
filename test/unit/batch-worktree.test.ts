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
import { createWorktree, installManifest, worktreePath } from "../../src/batch/worktree";

let root: string;
const MANIFEST = "version: '1.2'\nsession:\n  id: b-b9-t164\n";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
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
