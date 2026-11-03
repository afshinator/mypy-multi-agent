/**
 * Pure parser for the project's `mypi-multi-agent.yaml`. Text in, a validated
 * `{ version, taskDirs, batchDir }` out; no fs and no node/bun imports
 * (ADR 0001), so the browser run inspector can read the same config. The
 * runtime supplies the file.
 *
 * `taskDirs` are the run targets; `batchDir` is the record segment the batch
 * driver writes under `taskDirs[0]`, so the dirty-tree guard covers it through
 * the task-dir exemption alone.
 */
import { parse } from "yaml";

export interface MultiAgentConfig {
  version: number;
  taskDirs: [string, ...string[]];
  /** Record segment inside `taskDirs[0]`; a single name, never a path. */
  batchDir: string;
}

/** Parse and validate the config; throws on an unknown version, a bad taskDirs,
 * a bad batchDir, or malformed YAML (the yaml parser throws). */
export function parseMultiAgentConfig(text: string): MultiAgentConfig {
  const raw: unknown = parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("mypi-multi-agent.yaml must be a mapping");
  }
  const { version, taskDirs, batchDir = "000-batches" } = raw as Record<string, unknown>;
  if (version !== 1) {
    throw new Error(`unknown mypi-multi-agent.yaml version: ${JSON.stringify(version)}`);
  }
  if (!Array.isArray(taskDirs) || taskDirs.length === 0) {
    throw new Error("mypi-multi-agent.yaml taskDirs must be a non-empty list");
  }
  if (taskDirs.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error("mypi-multi-agent.yaml taskDirs entries must be non-empty strings");
  }
  if (typeof batchDir !== "string" || batchDir.trim() === "" || batchDir.includes("/")) {
    throw new Error("mypi-multi-agent.yaml batchDir must be a single non-empty path segment");
  }
  return {
    version,
    taskDirs: taskDirs as [string, ...string[]],
    batchDir,
  };
}
