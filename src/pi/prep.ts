#!/usr/bin/env bun
/**
 * `just prep <name>` in code: a worktree for one authored task, clean enough to launch.
 *
 * The recipe used to symlink `node_modules`, and `.gitignore` lists `node_modules/` — a
 * directory rule — so the symlink was untracked, `classifyDirtyTree` refused the launch, and
 * `bun run check` failed for lack of `web/node_modules`. This delegates to the same module the
 * batch driver uses, so there is one implementation of "prepare a worktree".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseMultiAgentConfig } from "../../shared/parse-multi-agent-config";
import { createWorktree, installManifest } from "../batch/worktree";
import { checkLaunchPreconditions } from "./launch-preconditions";

export interface PrepResult {
  path: string;
  branch: string;
  manifest: string;
}

export async function prepWorktree(input: {
  repoRoot: string;
  name: string;
  base?: string;
}): Promise<PrepResult> {
  const config = parseMultiAgentConfig(
    readFileSync(resolve(input.repoRoot, "mypi-multi-agent.yaml"), "utf8"),
  );
  const taskDir = config.taskDirs[0];
  const authored = resolve(input.repoRoot, taskDir, input.name, "session.yaml");
  // The same check the batch runs before a workspace exists, so `just task` refuses in the same words
  // and before anything is created (#563).
  const problems = checkLaunchPreconditions({
    repoRoot: input.repoRoot,
    taskDir,
    slug: input.name,
  });
  if (problems.length !== 0) throw new Error(problems[0] ?? "the launch preconditions failed");

  const worktree = await createWorktree({
    repoRoot: input.repoRoot,
    taskDir,
    slug: input.name,
    reuse: true,
    ...(input.base === undefined ? {} : { base: input.base }),
  });
  const manifest = installManifest({
    worktree: worktree.path,
    taskDir,
    slug: input.name,
    manifestText: readFileSync(authored, "utf8"),
  });
  return { path: worktree.path, branch: worktree.branch, manifest };
}

if (import.meta.main) {
  const name = process.argv[2];
  if (name === undefined) {
    console.error("usage: bun src/pi/prep.ts <name>");
    process.exit(1);
  }
  prepWorktree({ repoRoot: process.cwd(), name })
    .then((r) => console.log(`ready: ${r.path} (branch ${r.branch})`))
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
