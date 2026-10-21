/**
 * Load and curate artifacts from prior feedback-workshop task runs.
 * Builds a data manifest (artifact availability + scorecard frontmatter)
 * for agents to read during analysis.
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionConfig } from "../contracts/session-schema";

export interface ArtifactInfo {
  available: boolean;
  path?: string;
  size_bytes?: number;
  optional: boolean;
}

export interface ScorecardFrontmatter {
  outcome: string | null;
  cost: number | null;
  tokens: number | null;
}

export interface TaskManifestEntry {
  task_id: string;
  run_path: string;
  artifacts: Record<string, ArtifactInfo>;
  scorecard_frontmatter?: ScorecardFrontmatter;
}

export interface DataManifest {
  manifest_version: "1.0";
  tasks: TaskManifestEntry[];
}

const ARTIFACTS = {
  final_md: { name: "final.md", optional: false },
  scorecard_json: { name: "scorecard.json", optional: true },
  findings_md: { name: "findings.md", optional: false },
  conversation_jsonl: { name: "conversation.jsonl", optional: false },
  tool_calls_jsonl: { name: "tool-calls.jsonl", optional: true },
};

function checkArtifacts(runDetailsDir: string): Record<string, ArtifactInfo> {
  const result: Record<string, ArtifactInfo> = {};

  for (const [key, meta] of Object.entries(ARTIFACTS)) {
    const path = join(runDetailsDir, meta.name);
    const available = existsSync(path);
    result[key] = {
      available,
      path: available ? path : undefined,
      size_bytes: available ? statSync(path).size : undefined,
      optional: meta.optional,
    };
  }

  return result;
}

async function readScorecardFrontmatter(
  runDetailsDir: string,
): Promise<ScorecardFrontmatter | undefined> {
  const path = join(runDetailsDir, "scorecard.json");
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const content = await readFile(path, "utf-8");
    const scorecard = JSON.parse(content) as Record<string, unknown>;
    const cost = scorecard.cost as Record<string, unknown> | undefined;
    return {
      outcome: (scorecard.outcome as string) ?? null,
      cost: (cost?.totalCostUsd as number) ?? null,
      tokens: (cost?.totalTokens as number) ?? null,
    };
  } catch {
    // If scorecard is malformed, return undefined (agents can request it directly)
    return undefined;
  }
}

/**
 * Load artifacts from feedback-workshop input task paths.
 * Resolves paths relative to taskDir, checks artifact availability,
 * extracts scorecard frontmatter, and returns a data manifest.
 *
 * Throws if:
 * - role is not feedback-workshop
 * - a task path does not exist
 * - fewer than 2 tasks resolve successfully
 */
export async function loadFeedbackWorkshopArtifacts(
  config: SessionConfig,
  taskDir: string,
): Promise<DataManifest> {
  const role = config.session.role ?? "standard";
  if (role !== "feedback-workshop") {
    throw new Error("loadFeedbackWorkshopArtifacts only for feedback-workshop role");
  }

  const input_tasks = config.session.input_tasks ?? [];
  const tasks: TaskManifestEntry[] = [];

  for (const relPath of input_tasks) {
    const abs = resolve(taskDir, relPath, "run-details");
    if (!existsSync(abs)) {
      throw new Error(`task path not found: ${relPath} (resolved to ${abs})`);
    }

    const task_id = basename(dirname(abs));
    const artifacts = checkArtifacts(abs);
    const scorecard = await readScorecardFrontmatter(abs);

    tasks.push({
      task_id,
      run_path: abs,
      artifacts,
      scorecard_frontmatter: scorecard,
    });
  }

  if (tasks.length < 2) {
    throw new Error(
      `must resolve at least 2 task paths, got ${tasks.length} (schema should have caught this)`,
    );
  }

  return {
    manifest_version: "1.0",
    tasks,
  };
}
