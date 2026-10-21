import type { Timeline } from "./timeline";

export interface NodeGraphNode {
  id: string;
  isSupervisor: boolean;
}

export interface NodeGraphEdge {
  source: string;
  target: string;
  count: number;
}

export interface NodeGraph {
  nodes: NodeGraphNode[];
  edges: NodeGraphEdge[];
}

const SEP = "\u2192";

/** Derive the agent dependency graph from the orchestration timeline. */
export function buildNodeGraph(timeline: Timeline): NodeGraph {
  const edgeCounts = new Map<string, number>();
  const ids = new Set<string>();

  for (const event of timeline.events) {
    const source = event.sender ?? "supervisor";
    const target = event.recipient ?? "supervisor";
    if (source === target) continue;
    ids.add(source);
    ids.add(target);
    const key = source < target ? `${source}${SEP}${target}` : `${target}${SEP}${source}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }

  const sorted = [...ids].sort((a, b) => {
    if (a === "supervisor") return -1;
    if (b === "supervisor") return 1;
    return a.localeCompare(b);
  });

  return {
    nodes: sorted.map((id) => ({ id, isSupervisor: id === "supervisor" })),
    edges: [...edgeCounts.entries()].map(([key, count]) => {
      const [source, target] = key.split(SEP);
      return { source: source ?? "", target: target ?? "", count };
    }),
  };
}
