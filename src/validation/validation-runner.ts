/**
 * Mechanical validation gate: runs the configured commands only when code
 * changed; success requires a non-failed result.
 */
export interface ValidationConfig {
  commands: string[];
}

export type ValidationResult =
  | { status: "not-configured" }
  | { status: "skipped" }
  | { status: "passed" }
  | { status: "failed"; command: string };

/**
 * Mechanical validation only applies when configured AND code changed.
 * No config = semantic DoD alone; config but no change = skip the gate.
 */
export async function runValidation(
  config: ValidationConfig | undefined,
  changed: boolean,
  exec: (command: string) => Promise<boolean>,
): Promise<ValidationResult> {
  if (!config || config.commands.length === 0) return { status: "not-configured" };
  if (!changed) return { status: "skipped" };
  for (const command of config.commands) {
    if (!(await exec(command))) return { status: "failed", command };
  }
  return { status: "passed" };
}

/** Success requires semantic DoD AND a non-failed validation result. */
export function validationAllowsSuccess(result: ValidationResult): boolean {
  return result.status !== "failed";
}
