import type { DirReader } from "./reader";

export interface Peer {
  id: string;
  state: string;
  model?: string;
  usageCostUsd?: number;
  usageTokens?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  lastCompletedWorkOrder?: string;
}

export interface PeerRoster {
  peers: Peer[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Build the typed peer roster from run-state.json text. */
export function buildPeerRoster(runStateJson: string): PeerRoster {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runStateJson);
  } catch {
    return { peers: [] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.agents)) return { peers: [] };

  const peers: Peer[] = [];
  for (const agent of parsed.agents) {
    if (!isRecord(agent)) continue;
    const id = str(agent.id);
    if (id === undefined) continue;
    const usage = isRecord(agent.usage) ? agent.usage : undefined;
    const budget = isRecord(agent.budget) ? agent.budget : undefined;
    peers.push({
      id,
      state: str(agent.state) ?? "unknown",
      model: str(agent.model),
      usageCostUsd: usage !== undefined ? num(usage.costUsd) : undefined,
      usageTokens: usage !== undefined ? num(usage.tokens) : undefined,
      maxCostUsd: budget !== undefined ? num(budget.maxCostUsd) : undefined,
      maxTokens: budget !== undefined ? num(budget.maxTokens) : undefined,
      lastCompletedWorkOrder: str(agent.lastCompletedWorkOrder),
    });
  }
  return { peers };
}

/** Load a task's run-state.json through the reader; null when absent. */
export async function loadPeerRoster(
  reader: DirReader,
  runDetailsPath: string,
): Promise<PeerRoster | null> {
  const state = await reader.readText(`${runDetailsPath}/run-state.json`);
  return state === null ? null : buildPeerRoster(state.text);
}
