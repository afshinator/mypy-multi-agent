/**
 * Issue #134: the first-tool-call probe, as a pure decision seam. A slug that
 * has never produced a tool call is not trusted with a writer role until it
 * does: within the probe window the first observed tool call lets the
 * assignment proceed, and no tool call by the window's end reports the slug
 * unproven. The verdict comes from tool-call activity alone — a reply is never
 * evidence, because the failure this fixes was a live, tooling peer written off
 * on the strength of a silent reply. Pure: the runtime polls observations
 * through this seam, so the decision is unit-testable without a bus.
 */

/** The shipped probe window (issue #134: a 30 s first-tool-call probe). */
export const FIRST_TOOL_CALL_PROBE_WINDOW_MS = 30_000;

/** What the runtime observes about one slug while a probe is running. */
export interface ProbeObservation {
  /** Completed tool calls observed for the slug (lifetime), from tool-calls.jsonl. */
  toolCalls: number;
  /**
   * Whether the peer reported tool activity on its heartbeat during the window:
   * a tool call *started*, not necessarily finished. The stall detector already
   * trusts this signal, so the probe must too — otherwise a live peer whose first
   * call runs longer than the window is benched by the check that exists to
   * protect it.
   */
  progressed: boolean;
  /**
   * Whether the slug replied to the probe prompt. Deliberately not read by the
   * decision: a reply without a tool call proves nothing about the slug's
   * ability to act, and a silent slug that is tooling is alive.
   */
  replied: boolean;
  /** Milliseconds since the probe started. */
  elapsedMs: number;
  /** The probe window (FIRST_TOOL_CALL_PROBE_WINDOW_MS unless configured). */
  windowMs: number;
}

export type ProbeVerdict =
  | { action: "proceed"; reason: "tool call observed" | "progress observed" }
  | { action: "wait" }
  | { action: "unproven"; reason: "no tool activity within the probe window" };

/** One probe tick: proven on tool activity — a completed call, or a call that has
 * started — and unproven only when the window is spent with neither. */
export function firstToolCallProbe(o: ProbeObservation): ProbeVerdict {
  if (o.toolCalls >= 1) return { action: "proceed", reason: "tool call observed" };
  if (o.progressed) return { action: "proceed", reason: "progress observed" };
  if (o.elapsedMs >= o.windowMs)
    return { action: "unproven", reason: "no tool activity within the probe window" };
  return { action: "wait" };
}

/** A candidate writer: the model and whether the peer may edit. */
export interface ProbeCandidate {
  model: string;
  edit: boolean;
}

/**
 * Whether a work order is a writer role for a free-class slug — the class the
 * probe applies to (the class whose slugs were swapped after 422 s waits, and
 * the class that carries the shorter stall deadline). Priced slugs and
 * read-only peers are not probed.
 */
export function writerRoleProbeEligible(
  agent: ProbeCandidate,
  workOrder: { writeScope?: string[] },
  isFreeModel: (model: string) => boolean,
): boolean {
  return agent.edit && workOrder.writeScope !== undefined && isFreeModel(agent.model);
}

/** Whether the probe must run: an eligible writer role on a slug with no
 * observed tool call. */
export function writerRoleNeedsProbe(
  agent: ProbeCandidate,
  workOrder: { writeScope?: string[] },
  observedToolCalls: number,
  isFreeModel: (model: string) => boolean,
): boolean {
  return writerRoleProbeEligible(agent, workOrder, isFreeModel) && observedToolCalls === 0;
}
