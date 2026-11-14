/**
 * Batch policy: the root `mypi-batch.yaml`. Shape only — this loader does not touch
 * the filesystem, so a template path it accepts may still be missing; resolving it is
 * `prepare`'s job, where the failure has a ticket and a reason code attached.
 */
import { parse } from "yaml";

/**
 * The labels the driver reads and writes. They are this project's words, not a universal vocabulary,
 * so a repository that uses different ones names them here; a repository that runs `prepare` at all
 * has this file, so nothing is guessed from a label nobody declared (#502).
 */
export interface BatchLabels {
  /** The label an accepted prepare adds, and that `run` consumes. */
  ready: string;
  /** Where a refusal caused by the ticket itself moves it. */
  needsInfo: string;
  /** The opt-out: a ticket carrying it is skipped without a call. */
  skipped: string;
  /** What a successful run leaves behind, so nothing grabs it again. */
  human: string;
  /**
   * Whether a ticket-caused refusal moves `ready` to `needsInfo`. Off unless a repository says so: a
   * refused ticket that keeps the `ready` label is a trap, but another tracker's `ready` label may
   * mean something this driver must not rewrite.
   */
  onRefusal: boolean;
}

/** Every label as this project names it, so an existing `mypi-batch.yaml` keeps working unchanged. */
export const DEFAULT_LABELS: BatchLabels = {
  ready: "ready-for-agent",
  needsInfo: "needs-info",
  skipped: "not-batched",
  human: "ready-for-human",
  onRefusal: false,
};

export interface BatchPolicy {
  prepare: {
    /** What the triage agent may return as its kind, injected into the prompt. */
    kinds: string[];
    kindTemplates: Record<string, string>;
    triageModel: string;
    /** A different family from `triageModel`, or the verifier shares its blind spots. */
    verifierModel: string;
    agentTimeoutMinutes: number;
    /** Refuse a ticket whose GitHub blocker is still open. Off by default: advisory, never a gate. */
    refuseBlocked: boolean;
  };
  run: { timeoutMinutes: number };
  labels: BatchLabels;
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

/** One label name, defaulted when the key is absent and refused when it is blank. */
function label(value: unknown, at: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${at} must be a non-empty label`);
  return value.trim();
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
  const labels = root.labels === undefined ? {} : mapping(root.labels, "labels");
  const onRefusal = labels.on_refusal ?? DEFAULT_LABELS.onRefusal;
  if (typeof onRefusal !== "boolean") throw new Error("labels.on_refusal must be true or false");
  return {
    prepare: {
      kinds,
      kindTemplates: Object.fromEntries(kinds.map((k) => [k, templates[k] as string])),
      triageModel: model(prepare.triage_model, "prepare.triage_model"),
      verifierModel: model(prepare.verifier_model, "prepare.verifier_model"),
      agentTimeoutMinutes: positive(prepare.agent_timeout_minutes, "prepare.agent_timeout_minutes"),
      refuseBlocked: prepare.refuse_blocked === true,
    },
    run: { timeoutMinutes: positive(run.timeout_minutes, "run.timeout_minutes") },
    labels: {
      ready: label(labels.ready, "labels.ready", DEFAULT_LABELS.ready),
      needsInfo: label(labels.needs_info, "labels.needs_info", DEFAULT_LABELS.needsInfo),
      skipped: label(labels.skipped, "labels.skipped", DEFAULT_LABELS.skipped),
      human: label(labels.human, "labels.human", DEFAULT_LABELS.human),
      onRefusal,
    },
  };
}
