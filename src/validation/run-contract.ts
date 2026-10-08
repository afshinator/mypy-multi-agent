/**
 * System-owned run contract: outputs every run must produce regardless of the
 * task's DoD. Checked at finalize — a missing artifact forces the run to fail,
 * so "artifacts are the system's job, not the DoD's" is enforced, not just asked.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Artifacts the supervisor must have produced before it finalizes. */
export const REQUIRED_ARTIFACTS = ["plan.md"] as const;

export interface RunContractResult {
  ok: boolean;
  missing: string[];
}

/** Missing = absent from `runDetailsDir`. */
export function checkRunContract(runDetailsDir: string): RunContractResult {
  const missing = REQUIRED_ARTIFACTS.filter((f) => !existsSync(join(runDetailsDir, f)));
  return { ok: missing.length === 0, missing };
}
