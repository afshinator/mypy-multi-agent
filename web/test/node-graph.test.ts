import { describe, expect, it } from "vitest";
import { buildNodeGraph } from "../lib/node-graph";
import type { Timeline, TimelineEvent } from "../lib/timeline";

const ev = (sender: string, recipient: string): TimelineEvent => ({
  timestamp: 0,
  type: "PROMPT",
  sender,
  recipient,
  isOpen: false,
  isClose: false,
});

const timeline = (events: TimelineEvent[]): Timeline => ({
  events,
  durationsByAgent: {},
  actors: [],
  types: [],
});

describe("buildNodeGraph", () => {
  it("derives nodes and undirected edges from supervisor<->peer flow", () => {
    const graph = buildNodeGraph(
      timeline([ev("supervisor", "dev_a"), ev("dev_a", "supervisor"), ev("supervisor", "dev_b")]),
    );
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["dev_a", "dev_b", "supervisor"]);
    expect(graph.nodes.find((n) => n.id === "supervisor")?.isSupervisor).toBe(true);
    expect(graph.edges).toHaveLength(2);
  });

  it("skips self-edges and counts duplicate messages", () => {
    const graph = buildNodeGraph(
      timeline([ev("supervisor", "dev_a"), ev("supervisor", "dev_a"), ev("dev_a", "dev_a")]),
    );
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.count).toBe(2);
  });
});
