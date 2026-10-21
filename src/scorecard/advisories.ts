/**
 * Pre-run advisories (issue #15): M4 (weak DoD) and M5 (roster). Pure checks over
 * the authored session config. Advisory only — a caller warns, never blocks.
 *
 * M5 covers the roster's structural risks (shared slugs, no diversity). It does
 * NOT check model *evidence* — that needs the cross-run probe corpus (#19).
 */
import type { SessionConfig } from "../contracts/session-schema";
import { duplicateModelSlugs } from "../pi/model-preflight";

export interface Advisory {
  class: "M4" | "M5";
  detail: string;
}

/** A criterion is weak if it is too short to pin a check, or leans on a vague
 * quality word with no observable. Shortness and vagueness are the signals; a
 * positive whitelist of "checkable" words misfires on reasonable criteria. */
const VAGUE_QUALITY =
  /\b(appropriate|appropriately|as needed|if needed|properly|reasonable|reasonably|good|better|nice|robust|clean|cleanly|etc\.?|and so on|well)\b/i;

function dodAdvisories(config: SessionConfig): Advisory[] {
  const out: Advisory[] = [];
  // dodAdvisories is only called for standard-role runs
  if (!config.ask) return out;
  const dod = config.ask.definition_of_done;
  if (dod.length < 3) {
    out.push({
      class: "M4",
      detail: `DoD has ${dod.length} criterion/criteria; fewer than 3 is usually not checkable enough`,
    });
  }
  const weak = dod.filter((c) => c.trim().length < 25 || VAGUE_QUALITY.test(c)).length;
  if (weak > 0) {
    out.push({
      class: "M4",
      detail: `${weak} criterion/criteria look non-checkable (too short or vague quality wording)`,
    });
  }
  return out;
}

function rosterAdvisories(config: SessionConfig): Advisory[] {
  const out: Advisory[] = [];
  // rosterAdvisories is only called for standard-role runs
  const agents = config.agents;
  if (!agents || agents.length === 0) return out;
  for (const dup of duplicateModelSlugs(agents)) {
    out.push({
      class: "M5",
      detail: `model ${dup.model} shared by ${dup.agentIds.join(", ")} (one provider failure takes out both)`,
    });
  }
  const distinct = new Set(agents.map((a) => a.model));
  if (agents.length > 1 && distinct.size === 1) {
    out.push({
      class: "M5",
      detail: `all ${agents.length} agents share one model (no diversity)`,
    });
  }
  return out;
}

/** All pre-run advisories for a session config. Never blocks. */
export function checkSessionConfig(config: SessionConfig): Advisory[] {
  return [...dodAdvisories(config), ...rosterAdvisories(config)];
}
