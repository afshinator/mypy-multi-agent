import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    // A worktree without web/node_modules cannot pass `bun run check` (design F10).
    expect(
      readFileSync(join(worktree.path, "web", "node_modules", "..", "..", "package.json"), "utf8"),
    ).toBe("{}\n");
    expect(existsSync(join(worktree.path, "node_modules"))).toBe(true);
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
