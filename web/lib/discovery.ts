import {
  type MultiAgentConfig,
  parseMultiAgentConfig,
} from "../../shared/parse-multi-agent-config";
import type { DirReader } from "./reader";

export interface DiscoveredTask {
  /** Task directory name; unique across the ordered taskDirs after dedup. */
  name: string;
  /** `<taskDir>/<name>` relative to the project root. */
  taskPath: string;
  /** `<taskDir>/<name>/run-details` relative to the project root. */
  runDetailsPath: string;
  /** mtime of conversation.jsonl (always present in a run), 0 when unknown. */
  mtimeMs: number;
}

const CONFIG_FILE = "mypi-multi-agent.yaml";
const RUN_DETAILS_DIR = "run-details";

const joinRoot = (root: string, path: string): string => (root === "" ? path : `${root}/${path}`);

/**
 * Read a project root's config and list its tasks through the DirReader seam.
 * Missing or unparseable config yields an empty list. Each taskDir is walked in
 * order; a child dir must contain a `run-details/` dir to count, and the first
 * occurrence of a task name wins across taskDirs.
 */
export async function discoverProjects(reader: DirReader, root: string): Promise<DiscoveredTask[]> {
  const configText = await reader.readText(joinRoot(root, CONFIG_FILE));
  if (configText === null) return [];

  let config: MultiAgentConfig;
  try {
    config = parseMultiAgentConfig(configText.text);
  } catch {
    return [];
  }

  const tasks: DiscoveredTask[] = [];
  const seen = new Set<string>();
  for (const taskDir of config.taskDirs) {
    const children = await reader.list(joinRoot(root, taskDir));
    for (const child of children) {
      if (!child.isDir || seen.has(child.name)) continue;

      const taskPath = `${taskDir}/${child.name}`;
      const entries = await reader.list(joinRoot(root, taskPath));
      const hasRunDetails = entries.some((e) => e.name === RUN_DETAILS_DIR && e.isDir);
      if (!hasRunDetails) continue;

      seen.add(child.name);
      const runDetailsPath = `${taskPath}/${RUN_DETAILS_DIR}`;
      const conversation = await reader.readText(
        joinRoot(root, `${runDetailsPath}/conversation.jsonl`),
      );
      tasks.push({
        name: child.name,
        taskPath,
        runDetailsPath,
        mtimeMs: conversation?.mtimeMs ?? 0,
      });
    }
  }
  return tasks;
}
