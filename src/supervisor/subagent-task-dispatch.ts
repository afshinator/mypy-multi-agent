/**
 * Build subagent tasks for worker dispatch.
 * Converts system prompts + manifest into subagent task structures.
 * Ready for subagent({ tasks: [...] }) execution.
 */
import type { SessionConfig } from "../contracts/session-schema";
import { buildCostAuditorPrompt } from "./cost-auditor-prompt";
import { buildFrictionDetectorPrompt } from "./friction-detector-prompt";
import type { DataManifest } from "./load-prior-runs";
import { buildSpecFinderPrompt } from "./spec-finder-prompt";

export interface WorkerTask {
  id: string;
  agent: "cost-auditor" | "spec-finder" | "friction-detector";
  prompt: string;
}

/**
 * Build 3 worker tasks for parallel subagent dispatch.
 * Each task includes system prompt + manifest data.
 * @param manifest DataManifest with task artifacts
 * @param config SessionConfig with analyze block
 * @returns Array of 3 WorkerTask objects ready for subagent({ tasks: [...] })
 */
export function buildWorkerTasks(manifest: DataManifest, config: SessionConfig): WorkerTask[] {
  const costAuditorPrompt = buildCostAuditorPrompt(manifest);
  const specFinderPrompt = buildSpecFinderPrompt(manifest, config);
  const frictionDetectorPrompt = buildFrictionDetectorPrompt(manifest);

  return [
    {
      id: "cost-auditor",
      agent: "cost-auditor",
      prompt: costAuditorPrompt,
    },
    {
      id: "spec-finder",
      agent: "spec-finder",
      prompt: specFinderPrompt,
    },
    {
      id: "friction-detector",
      agent: "friction-detector",
      prompt: frictionDetectorPrompt,
    },
  ];
}
