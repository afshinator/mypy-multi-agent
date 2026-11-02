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
import { worktreePath } from "../../src/batch/worktree";
import { classifyDirtyTree } from "../../src/pi/launch";
import { prepWorktree } from "../../src/pi/prep";

let root: string;
const NAME = "prep-probe";

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"])
    delete env[key];
  return env;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mypi-prep-"));
  git(["init", "-q", "-b", "main"], root);
  writeFileSync(join(root, "mypi-multi-agent.yaml"), "version: 1\ntaskDirs:\n  - mypi-tasks\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\nmypi-tasks/run-*\n");
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "web", ".gitignore"), "node_modules/\n");
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "web", "node_modules"), { recursive: true });
  mkdirSync(join(root, "mypi-tasks", NAME), { recursive: true });
  writeFileSync(
    join(root, "mypi-tasks", NAME, "session.yaml"),
    "version: '1.2'\nsession:\n  id: x\n",
  );
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], root);
});

afterEach(() => {
  const path = worktreePath(root, NAME);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("prepWorktree", () => {
  it("leaves a worktree the launcher will accept: no symlinked modules, clean status", async () => {
    const result = await prepWorktree({ repoRoot: root, name: NAME });

    expect(result.branch).toBe(`task/${NAME}`);
    expect(git(["branch", "--show-current"], result.path).trim()).toBe(`task/${NAME}`);

    // A symlink is untracked, not ignored, so the tree would be dirty and the launcher would
    // refuse — measured on the recipe before this change.
    expect(lstatSync(join(result.path, "node_modules")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(result.path, "web", "node_modules")).isDirectory()).toBe(true);

    const status = git(["status", "--porcelain"], result.path);
    expect(classifyDirtyTree(status, ["mypi-tasks"])).toEqual({ allow: true, dirtyPaths: [] });
  });

  it("copies the authored manifest into the worktree", async () => {
    const result = await prepWorktree({ repoRoot: root, name: NAME });

    expect(result.manifest).toBe(join(result.path, "mypi-tasks", NAME, "session.yaml"));
    expect(readFileSync(result.manifest, "utf8")).toContain("session:");
  });

  it("reuses an existing worktree and refreshes the manifest", async () => {
    await prepWorktree({ repoRoot: root, name: NAME });
    writeFileSync(
      join(root, "mypi-tasks", NAME, "session.yaml"),
      "version: '1.2'\nsession:\n  id: changed\n",
    );

    const again = await prepWorktree({ repoRoot: root, name: NAME });

    expect(readFileSync(again.manifest, "utf8")).toContain("changed");
  });

  it("refuses when the task has no authored manifest", async () => {
    await expect(prepWorktree({ repoRoot: root, name: "nope" })).rejects.toThrow(
      /author the task config/,
    );
  });

  it("refuses to run from inside a worktree", async () => {
    const first = await prepWorktree({ repoRoot: root, name: NAME });
    // Give the second task a manifest, so the worktree guard is what refuses, not the file check.
    mkdirSync(join(first.path, "mypi-tasks", "second"), { recursive: true });
    writeFileSync(join(first.path, "mypi-tasks", "second", "session.yaml"), "version: '1.2'\n");

    await expect(prepWorktree({ repoRoot: first.path, name: "second" })).rejects.toThrow(
      /main checkout/,
    );
  });
});
