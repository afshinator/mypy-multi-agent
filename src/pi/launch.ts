#!/usr/bin/env bun
/**
 * Launcher (portability seam A): the `just run` herdr bootstrap as a plain
 * bun/node script, so starting the supervisor no longer depends on `just` or a
 * justfile.
 *
 * Invoke it path-independently — `mypi-run [dir]` (after `npm link`) or
 * `bun /abs/path/to/mypy-multi-agent/src/pi/launch.ts [dir]`. `bun run start`
 * only works from inside this repo (bun resolves the local package.json).
 *
 * `buildLaunchPlan` is pure (the tested contract); `main` executes it and is
 * exercised only in a live herdr environment.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseMultiAgentConfig } from "../../shared/parse-multi-agent-config";

export interface LaunchPlan {
  label: string;
  cwd: string;
  /** `herdr` args that create the supervisor workspace and its root pane. */
  createArgs: string[];
  /** Command run inside that pane: start pi, close the pane when pi exits. */
  paneCommand: string;
}

/** Already inside a herdr pane? If so, there is nothing to bootstrap. */
export function inHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID);
}

/** Porcelain line format: `XY path` or `XY old -> new` for renames. The rename
 * target is the live path an editing peer can destroy, so it is what matters. */
function porcelainPath(line: string): string | null {
  const path = line.slice(3);
  if (path === "") return null;
  const arrow = path.indexOf(" -> ");
  return arrow === -1 ? path : path.slice(arrow + 4);
}

function isUnderTaskDir(path: string, taskDirs: readonly string[]): boolean {
  return taskDirs.some((dir) => {
    const normalized = dir.replace(/\/+$/, "");
    return normalized !== "" && (path === normalized || path.startsWith(`${normalized}/`));
  });
}

export interface DirtyTreeVerdict {
  allow: boolean;
  dirtyPaths: string[];
}

/** Classify `git status --porcelain` output against the config task dirs.
 * Every non-empty line is a dirty path; only paths under a task dir are exempt.
 * Pure: text in, verdict out. */
export function classifyDirtyTree(
  statusOutput: string,
  taskDirs: readonly string[],
): DirtyTreeVerdict {
  const dirtyPaths = statusOutput
    .split("\n")
    .map(porcelainPath)
    .filter((path): path is string => path !== null)
    .filter((path) => !isUnderTaskDir(path, taskDirs));
  return { allow: dirtyPaths.length === 0, dirtyPaths };
}

export interface LaunchGuardArgs {
  resume: boolean;
  allowDirty: boolean;
}

export interface LaunchGuardDecision {
  action: "launch" | "refuse";
  dirtyPaths: string[];
}

/** Pure arg/guard decision: `--resume` skips and `--allow-dirty` overrides;
 * otherwise a dirty tree outside the task dirs refuses the launch. */
export function decideLaunchGuard(
  args: LaunchGuardArgs,
  statusOutput: string,
  taskDirs: readonly string[],
): LaunchGuardDecision {
  if (args.resume || args.allowDirty) {
    return { action: "launch", dirtyPaths: [] };
  }
  const { dirtyPaths } = classifyDirtyTree(statusOutput, taskDirs);
  return dirtyPaths.length === 0
    ? { action: "launch", dirtyPaths: [] }
    : { action: "refuse", dirtyPaths };
}

/** The herdr workspace bootstrap, mirroring the retired `justfile` run recipe.
 * `resume` switches the pane command to the explicit `/mypi-multi-agent --resume`
 * entry point; the default (no flag) stays byte-identical. */
export function buildLaunchPlan(
  cwd: string,
  label = "mypi-supervisor",
  resume = false,
): LaunchPlan {
  return {
    label,
    cwd,
    createArgs: [
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--label",
      label,
      "--focus",
      "--env",
      "SHELL_SESSIONS_DISABLE=1",
    ],
    paneCommand: resume
      ? 'pi "/mypi-multi-agent --resume"; herdr pane close "$HERDR_PANE_ID"'
      : 'pi; herdr pane close "$HERDR_PANE_ID"',
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resume = args.includes("--resume");
  const allowDirty = args.includes("--allow-dirty");
  const dirArg = args.find((a) => a !== "--resume" && a !== "--allow-dirty");
  const cwd = resolve(dirArg ?? process.cwd());
  if (inHerdr()) {
    console.error("already inside a herdr pane — run /mypi-multi-agent here instead");
    process.exit(1);
  }
  if (!resume && !allowDirty) {
    const configText = readFileSync(resolve(cwd, "mypi-multi-agent.yaml"), "utf8");
    const { taskDirs, recordDirs } = parseMultiAgentConfig(configText);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    // The batch driver writes inside recordDirs, so both lists are exempt.
    const decision = decideLaunchGuard({ resume, allowDirty }, status, [
      ...taskDirs,
      ...recordDirs,
    ]);
    if (decision.action === "refuse") {
      console.error(
        "refusing to start: uncommitted changes outside the task dirs:\n" +
          decision.dirtyPaths.map((path) => `  ${path}`).join("\n"),
      );
      console.error("commit or stash them, or re-run with --allow-dirty");
      process.exit(1);
    }
  }
  const plan = buildLaunchPlan(cwd, "mypi-supervisor", resume);
  const created = execFileSync("herdr", plan.createArgs, { encoding: "utf8" });
  const paneId = JSON.parse(created).result.root_pane.pane_id as string;
  execFileSync("herdr", ["pane", "run", paneId, plan.paneCommand], { stdio: "inherit" });
  spawnSync("herdr", [], { stdio: "inherit" });
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
