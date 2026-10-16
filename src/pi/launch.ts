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
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  const dirArg = args.find((a) => a !== "--resume");
  const cwd = resolve(dirArg ?? process.cwd());
  if (inHerdr()) {
    console.error("already inside a herdr pane — run /mypi-multi-agent here instead");
    process.exit(1);
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
