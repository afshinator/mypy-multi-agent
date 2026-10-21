import type { NodeGraph } from "../lib/node-graph";
import { agentClass } from "./svg";

const NS = "http://www.w3.org/2000/svg";
const R = 90;
const CX = 180;
const CY = 120;
const W = 360;
const H = 260;
// shortcut: fixed circular layout; with many peers (>~8) nodes overlap —
// upgrade to a force/spiral layout when real runs exceed a handful of agents.

/** Agent dependency graph: supervisor at the center, peers around, edges by message count. */
export function renderNodeGraph(root: HTMLElement, graph: NodeGraph): void {
  root.replaceChildren();
  if (graph.nodes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No agent flow recorded.";
    root.append(empty);
    return;
  }

  const supervisor = graph.nodes.find((n) => n.isSupervisor) ?? null;
  const peers = graph.nodes.filter((n) => !n.isSupervisor);
  const position = new Map<string, { x: number; y: number }>();
  if (supervisor !== null) position.set(supervisor.id, { x: CX, y: CY });
  peers.forEach((peer, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, peers.length) - Math.PI / 2;
    position.set(peer.id, { x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle) });
  });

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Agent dependency graph");

  for (const edge of graph.edges) {
    const a = position.get(edge.source);
    const b = position.get(edge.target);
    if (a === undefined || b === undefined) continue;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    line.setAttribute("class", "node-edge");
    line.setAttribute("stroke-width", String(Math.min(5, 1 + edge.count)));
    svg.append(line);
  }

  peers.forEach((peer, i) => {
    const p = position.get(peer.id);
    if (p !== undefined) svg.append(nodeGroup(p.x, p.y, 10, agentClass(i), peer.id));
  });
  if (supervisor !== null) {
    const p = position.get(supervisor.id);
    if (p !== undefined) svg.append(nodeGroup(p.x, p.y, 16, "node-supervisor", supervisor.id));
  }

  root.append(svg);
}

function nodeGroup(x: number, y: number, r: number, cls: string, label: string): SVGGElement {
  const g = document.createElementNS(NS, "g");
  const title = document.createElementNS(NS, "title");
  title.textContent = label;

  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", String(x));
  circle.setAttribute("cy", String(y));
  circle.setAttribute("r", String(r));
  circle.setAttribute("class", cls);

  const text = document.createElementNS(NS, "text");
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(y + r + 14));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("class", "chart-label");
  text.textContent = label;

  g.append(title, circle, text);
  return g;
}
