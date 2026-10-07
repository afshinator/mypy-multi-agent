/**
 * Agent lifecycle states and the legal transition table. Single authority for
 * valid agent state changes.
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

const TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  STARTING: ["PENDING", "CRASHED", "STOPPED"],
  PENDING: ["WORKING", "CRASHED", "STOPPED"],
  WORKING: ["WAITING", "DONE", "CRASHED", "STOPPED"],
  WAITING: ["WORKING", "CRASHED", "STOPPED"],
  DONE: ["WORKING", "CRASHED", "STOPPED"],
  CRASHED: [],
  STOPPED: [],
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: AgentState, to: AgentState): AgentState {
  if (!canTransition(from, to)) throw new Error(`invalid agent state transition ${from} -> ${to}`);
  return to;
}
