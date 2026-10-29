/**
 * Mistake classification for a run scorecard (issue #18): the post-run classes
 * M1 (stalled/slow), M2 (outcome/exit mismatch) and M3 (silent unsuccessful run).
 * Pure, over derived metrics only — detail strings carry numbers and normalized
 * enums, never free text from run artifacts (issue #14's privacy boundary).
 */
import type { SessionConfig } from "../contracts/session-schema";

export interface Mistake {
  class: "M1" | "M2" | "M3";
  detail: string;
}

/** The derived fields classification reads. A subset of RunScorecard. */
export interface MistakeInputs {
  outcome: string | null;
  exitCode: number | null;
  outcomeExitMismatch: boolean;
  dod: "met" | "unmet" | "unknown";
  falseSuccess: boolean;
  turnDurationsMs: Record<string, number[]>;
  agentStalled: number;
  correlationTimeouts: number;
}

export function classifyMistakes(m: MistakeInputs, config: SessionConfig): Mistake[] {
  const mistakes: Mistake[] = [];

  // M1 — stalled/slow: a recorded stall, a wait that timed out against a working
  // peer, or a turn at/over the stall threshold. 0 disables the threshold check.
  // Issue #134: the threshold stays the single session.stall_timeout_ms even
  // though a free-class peer runs under a shorter class deadline — M1 is the
  // session-level health signal, and moving it with the class split would make
  // ledger readings incomparable across runs.
  const threshold = config.session.stall_timeout_ms;
  let slowTurns = 0;
  if (threshold > 0) {
    for (const durations of Object.values(m.turnDurationsMs)) {
      for (const d of durations) if (d >= threshold) slowTurns++;
    }
  }
  if (m.agentStalled > 0 || m.correlationTimeouts > 0 || slowTurns > 0) {
    const bound = threshold > 0 ? ` (>=${threshold}ms)` : "";
    mistakes.push({
      class: "M1",
      detail: `stalled=${m.agentStalled} correlationTimeouts=${m.correlationTimeouts} slowTurns=${slowTurns}${bound}`,
    });
  }

  // M2 — the exit code and the recorded outcome disagree.
  if (m.outcomeExitMismatch) {
    mistakes.push({
      class: "M2",
      detail: `outcome=${m.outcome ?? "null"} exitCode=${m.exitCode ?? "null"}`,
    });
  }

  // M3 — recorded as successful but not actually met, or met with no attestation.
  if (m.falseSuccess) {
    mistakes.push({ class: "M3", detail: "exitCode=0 but DoD unmet" });
  } else if (m.outcome === "success" && m.dod === "unknown") {
    mistakes.push({ class: "M3", detail: "outcome=success with no attester verdict" });
  }

  return mistakes;
}
