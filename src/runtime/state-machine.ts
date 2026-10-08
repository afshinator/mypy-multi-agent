/**
 * Agent lifecycle state labels. The Runtime's `states` map is the single source
 * of truth for a peer's current state; this module only defines the legal label
 * set so the state type is shared and type-checked across call sites.
 */
const AGENT_STATES = [
  "STARTING",
  "PENDING",
  "WORKING",
  "WAITING",
  "DONE",
  "CRASHED",
  "STOPPED",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];
