import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMultiAgentConfig } from "../../shared/parse-multi-agent-config";

export const DEFAULT_TASK_DIR = "mypi-tasks";
export const DEFAULT_BATCH_DIR = "000-batches";

/** The configured first task dir, read once; undefined when the repo has no config. */
export function taskDirOf(cwd: string): string | undefined {
  const path = join(cwd, "mypi-multi-agent.yaml");
  if (!existsSync(path)) return undefined;
  return parseMultiAgentConfig(readFileSync(path, "utf8")).taskDirs[0];
}

/** The configured batch record segment; `000-batches` when there is no config. */
export function batchDirOf(cwd: string): string {
  const path = join(cwd, "mypi-multi-agent.yaml");
  if (!existsSync(path)) return DEFAULT_BATCH_DIR;
  return parseMultiAgentConfig(readFileSync(path, "utf8")).batchDir;
}

/** The batch record root: `<taskDirs[0]>/<batchDir>`, defaulting when there is no config. */
export function recordRoot(cwd: string): string {
  return join(taskDirOf(cwd) ?? DEFAULT_TASK_DIR, batchDirOf(cwd));
}
