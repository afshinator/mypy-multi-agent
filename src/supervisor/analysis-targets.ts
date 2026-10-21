/**
 * Resolve the run directories an analysis task points at.
 *
 * The task is handed paths, not a manifest: `session.input_tasks` entries are
 * resolved to `<taskDir>/<entry>/run-details`, verified to exist, and
 * inventoried. The inventory exists so the analysts are told which artifacts
 * are present (spans.jsonl is absent on older runs) instead of guessing.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionConfig } from "../contracts/session-schema";
import type { AnalysisTarget, RunArtifact } from "./analysis-types";

/**
 * Artifacts an analyst may want. Absence is normal, not an error: spans.jsonl
 * only exists on runs after tracing landed, scorecard.json only after #14.
 */
export const EXPECTED_ARTIFACTS = [
  "final.md",
  "findings.md",
  "conversation.jsonl",
  "tool-calls.jsonl",
  "spans.jsonl",
  "scorecard.json",
  "run-state.json",
] as const;

export interface ResolveOptions {
  /** Base directory that `session.input_tasks` entries are relative to. */
  taskDir: string;
}

/**
 * Resolve and inventory every target run directory.
 *
 * Throws when the role is not `analysis`, when an entry has no `run-details`
 * directory, or when nothing resolves. A missing *artifact* never throws — it
 * is reported in `missing` so the analysts can be told.
 */
export function resolveAnalysisTargets(
  config: SessionConfig,
  { taskDir }: ResolveOptions,
): AnalysisTarget[] {
  const role = config.session.role ?? "standard";
  if (role !== "analysis") {
    throw new Error(`resolveAnalysisTargets only for analysis role, got "${role}"`);
  }

  const entries = config.session.input_tasks ?? [];
  if (entries.length === 0) {
    throw new Error("analysis task needs session.input_tasks");
  }

  return entries.map((entry) => {
    const runDetailsDir = resolve(taskDir, entry, "run-details");
    if (!existsSync(runDetailsDir)) {
      throw new Error(`run directory not found for "${entry}" (resolved to ${runDetailsDir})`);
    }

    const artifacts: RunArtifact[] = [];
    const missing: string[] = [];

    for (const name of EXPECTED_ARTIFACTS) {
      const path = join(runDetailsDir, name);
      if (existsSync(path)) {
        artifacts.push({ name, path, bytes: statSync(path).size });
      } else {
        missing.push(name);
      }
    }

    if (artifacts.length === 0) {
      throw new Error(`"${entry}" has no recognised run artifacts in ${runDetailsDir}`);
    }

    return {
      id: entry,
      run_details_dir: runDetailsDir,
      artifacts,
      missing,
    };
  });
}

/** Render the inventory as the lines an analyst prompt uses. */
export function renderTargetInventory(targets: AnalysisTarget[]): string {
  return targets
    .map((t) => {
      const present = t.artifacts
        .map((a) => `    ${a.name} (${a.bytes} bytes) -> ${a.path}`)
        .join("\n");
      const absent =
        t.missing.length > 0 ? `\n  absent: ${t.missing.join(", ")}` : "\n  absent: (none)";
      return `- ${t.id}\n  directory: ${t.run_details_dir}\n  present:\n${present}${absent}`;
    })
    .join("\n\n");
}
