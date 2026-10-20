/**
 * Resolves which session.yaml to run, strictly from the ordered `taskDirs`
 * declared in the project's root `mypi-multi-agent.yaml`. A root `session.yaml`
 * and explicit file/directory paths are NOT consulted — every lookup is a task
 * name under a configured taskDir.
 * - A task name walks taskDirs in order and stops at the first match; none →
 *   `task '<name>' not found under taskDirs`.
 * - No name walks every taskDirs entry in order (name collisions first-wins):
 *   one task → resolve it; several distinct → `multiple session.yaml`; none →
 *   `no session.yaml found under the configured taskDirs`.
 * - No config → `project not configured to run mypi-multi-agent`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type MultiAgentConfig,
  parseMultiAgentConfig,
} from "../../shared/parse-multi-agent-config";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Read + validate the project config; a missing file is a hard error. */
async function readConfig(dir: string): Promise<MultiAgentConfig> {
  let text: string;
  try {
    text = await readFile(join(dir, "mypi-multi-agent.yaml"), "utf8");
  } catch {
    throw new Error("project not configured to run mypi-multi-agent");
  }
  return parseMultiAgentConfig(text);
}

export async function resolveSessionPath(dir: string, taskName?: string): Promise<string> {
  if (taskName) {
    const config = await readConfig(dir);
    for (const taskDir of config.taskDirs) {
      const named = join(taskDir, taskName, "session.yaml");
      if (await isFile(join(dir, named))) return named;
    }
    throw new Error(`task '${taskName}' not found under taskDirs`);
  }

  const config = await readConfig(dir);
  const byName = new Map<string, string>();
  for (const taskDir of config.taskDirs) {
    const entries = await readdir(join(dir, taskDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || byName.has(entry.name)) continue;
      const relative = join(taskDir, entry.name, "session.yaml");
      if (await isFile(join(dir, relative))) byName.set(entry.name, relative);
    }
  }
  const candidates = [...byName.values()];
  if (candidates.length > 1)
    throw new Error(`multiple session.yaml found — specify one: ${candidates.join(", ")}`);
  const [resolved] = candidates;
  if (!resolved) throw new Error("no session.yaml found under the configured taskDirs");
  return resolved;
}
