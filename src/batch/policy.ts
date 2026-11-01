/**
 * Batch policy: the root `mypi-batch.yaml`. Shape only — this loader does not touch
 * the filesystem, so a template path it accepts may still be missing; resolving it is
 * `prepare`'s job, where the failure has a ticket and a reason code attached.
 */
import { parse } from "yaml";

export interface BatchPolicy {
  prepare: {
    /** What the triage agent may return as its kind, injected into the prompt. */
    kinds: string[];
    kindTemplates: Record<string, string>;
    triageModel: string;
    /** A different family from `triageModel`, or the verifier shares its blind spots. */
    verifierModel: string;
    agentTimeoutMinutes: number;
  };
  run: { timeoutMinutes: number };
}

function mapping(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${at} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function positive(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${at} must be a positive number`);
  }
  return value;
}

function model(value: unknown, at: string): string {
  const slug = String(value ?? "");
  const parts = slug.split("/");
  if (parts.length < 2 || parts.some((p) => p === "")) {
    throw new Error(`${at} must be provider/model, got "${slug}"`);
  }
  return slug;
}

export function parsePolicy(text: string): BatchPolicy {
  const root = mapping(parse(text), "policy");
  if (root.version !== 1) throw new Error(`policy version must be 1, got ${String(root.version)}`);

  const prepare = mapping(root.prepare, "prepare");
  const rawKinds = prepare.kinds;
  if (!Array.isArray(rawKinds) || rawKinds.length === 0) {
    throw new Error("prepare.kinds must list at least one kind");
  }
  const kinds = rawKinds.map((k) => String(k));
  const seen = new Set<string>();
  for (const kind of kinds) {
    if (seen.has(kind)) throw new Error(`duplicate kind "${kind}"`);
    seen.add(kind);
  }

  const templates = mapping(prepare.kind_templates, "prepare.kind_templates");
  // Unknown key first: a typo is the likelier cause than a missing kind.
  for (const kind of Object.keys(templates)) {
    if (!seen.has(kind)) throw new Error(`template for unknown kind "${kind}"`);
  }
  for (const kind of kinds) {
    if (typeof templates[kind] !== "string") throw new Error(`no template for kind "${kind}"`);
  }

  const run = mapping(root.run, "run");
  return {
    prepare: {
      kinds,
      kindTemplates: Object.fromEntries(kinds.map((k) => [k, templates[k] as string])),
      triageModel: model(prepare.triage_model, "prepare.triage_model"),
      verifierModel: model(prepare.verifier_model, "prepare.verifier_model"),
      agentTimeoutMinutes: positive(prepare.agent_timeout_minutes, "prepare.agent_timeout_minutes"),
    },
    run: { timeoutMinutes: positive(run.timeout_minutes, "run.timeout_minutes") },
  };
}
