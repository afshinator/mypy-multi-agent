/**
 * Pure parser for the project's `mypi-multi-agent.yaml`. Text in, a validated
 * `{ version, taskDirs }` out; no fs and no node/bun imports (ADR 0001), so the
 * browser run inspector can read the same config. The runtime supplies the file.
 */
import { parse } from "yaml";

export interface MultiAgentConfig {
  version: number;
  taskDirs: [string, ...string[]];
}

/** Parse and validate the config; throws on an unknown version, a bad taskDirs,
 * or malformed YAML (the yaml parser throws). */
export function parseMultiAgentConfig(text: string): MultiAgentConfig {
  const raw: unknown = parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("mypi-multi-agent.yaml must be a mapping");
  }
  const { version, taskDirs } = raw as Record<string, unknown>;
  if (version !== 1) {
    throw new Error(`unknown mypi-multi-agent.yaml version: ${JSON.stringify(version)}`);
  }
  if (!Array.isArray(taskDirs) || taskDirs.length === 0) {
    throw new Error("mypi-multi-agent.yaml taskDirs must be a non-empty list");
  }
  if (taskDirs.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error("mypi-multi-agent.yaml taskDirs entries must be non-empty strings");
  }
  return { version, taskDirs: taskDirs as [string, ...string[]] };
}
