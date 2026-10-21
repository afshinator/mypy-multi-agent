import { renderNodeGraph } from "../charts/node-graph";
import type { NodeGraph } from "../lib/node-graph";

/** Service graph view: agent nodes and their message flow. */
export function renderNodeGraphView(graph: NodeGraph | null): HTMLElement {
  const section = document.createElement("section");
  section.className = "node-graph";

  const heading = document.createElement("h2");
  heading.textContent = "Service graph";
  section.append(heading);

  if (graph === null) {
    const missing = document.createElement("p");
    missing.className = "empty";
    missing.textContent = "Service graph not available (no conversation.jsonl).";
    section.append(missing);
    return section;
  }

  const chart = document.createElement("div");
  chart.className = "chart";
  renderNodeGraph(chart, graph);
  section.append(chart);
  return section;
}
