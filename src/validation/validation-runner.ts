/**
 * Mechanical validation gate: runs the configured commands only when code
 * changed; success requires a non-failed result.
 */
import { randomHex, type SpanHandle, type Tracing } from "../tracing/tracing";

export interface ValidationConfig {
  commands: string[];
}

export interface ValidationTracing {
  tracer: Tracing;
  parent: SpanHandle;
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
  tracing?: ValidationTracing,
): Promise<ValidationResult> {
  if (!config || config.commands.length === 0) return { status: "not-configured" };
  if (!changed) return { status: "skipped" };
  for (const command of config.commands) {
    // execution_id is assigned at invocation time, not inferred from log order.
    const span = tracing
      ? tracing.tracer.startSpan("validation.command", {
          parent: tracing.parent,
          kind: "run-level",
          scopeId: null,
          agentId: null,
          operationId: randomHex(8),
          attrs: { command },
        })
      : undefined;
    let ok: boolean;
    try {
      ok = await exec(command);
    } catch (err) {
      if (span) tracing?.tracer.endSpan(span, "error");
      throw err;
    }
    if (span) tracing?.tracer.endSpan(span, ok ? "ok" : "error");
    if (!ok) return { status: "failed", command };
  }
  return { status: "passed" };
}

export function validationAllowsSuccess(result: ValidationResult): boolean {
  return result.status !== "failed";
}
