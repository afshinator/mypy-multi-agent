/**
 * What a launch needs, checked before a workspace, pane or worktree exists (#563). The run's own
 * symptoms only say that nothing started; each entry here names the input and its path.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseMultiAgentConfig } from "../../shared/parse-multi-agent-config";

/** The agent directory pi reads when the launch names no other one (`src/batch/sandbox.ts:148-150`). */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
}

/** The extensions the operator's config would load, resolved the way pi resolves them. */
function registeredExtensions(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8")) as {
      extensions?: unknown;
    };
    if (!Array.isArray(parsed.extensions)) return [];
    return parsed.extensions
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => resolve(agentDir(), entry));
  } catch {
    return [];
  }
}

export interface LaunchInput {
  repoRoot: string;
  slug: string;
  /** Defaults to the first `taskDirs` entry the project config declares. */
  taskDir?: string;
  /** The extension the command names; without it the operator's config must supply a loadable one. */
  extension?: string;
}

/** Empty means launchable; every entry is a problem a reader can act on. */
export function checkLaunchPreconditions(input: LaunchInput): string[] {
  const problems: string[] = [];
  const configPath = resolve(input.repoRoot, "mypi-multi-agent.yaml");
  let taskDirs: string[] | undefined;
  try {
    taskDirs = parseMultiAgentConfig(readFileSync(configPath, "utf8")).taskDirs;
  } catch (err) {
    problems.push(`cannot use ${configPath}: ${(err as Error).message}`);
  }

  const taskDir = input.taskDir ?? taskDirs?.[0];
  if (taskDir !== undefined) {
    const session = resolve(input.repoRoot, taskDir, input.slug, "session.yaml");
    if (!existsSync(session)) problems.push(`no ${session} — the run has nothing to load`);
  }

  if (input.extension !== undefined) {
    if (!existsSync(input.extension)) {
      problems.push(`the extension pi must load is missing: ${input.extension}`);
    }
  } else if (!registeredExtensions().some((path) => existsSync(path))) {
    problems.push(
      `no loadable extension in ${join(agentDir(), "settings.json")} — /mypi-multi-agent would not exist`,
    );
  }
  return problems;
}
