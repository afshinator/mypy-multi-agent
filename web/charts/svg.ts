import type { SpanRecord, SpanStatus } from "../../shared/traceparent";

const NS = "http://www.w3.org/2000/svg";

export const ROW_H = 16;
export const MARGIN_LEFT = 140;
export const PLOT_W = 720;

export function svgRoot(width: number, height: number, label: string): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  return svg;
}

export function svgRect(x: number, y: number, w: number, h: number, cls: string): SVGRectElement {
  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("x", String(x));
  rect.setAttribute("y", String(y));
  rect.setAttribute("width", String(w));
  rect.setAttribute("height", String(h));
  rect.setAttribute("class", cls);
  return rect;
}

export function svgText(
  x: number,
  y: number,
  content: string,
  anchor: "start" | "end" = "start",
): SVGTextElement {
  const text = document.createElementNS(NS, "text");
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(y));
  text.setAttribute("text-anchor", anchor);
  text.setAttribute("class", "chart-label");
  text.textContent = content;
  return text;
}

/** Distinct categorical fill for an agent/service; index into tokens.css. */
export function agentClass(index: number): string {
  return `agent-${index % 6}`;
}

/** Sorted unique agent ids; "system" for spans without an agent. */
export function agentsOf(spans: SpanRecord[]): string[] {
  const agents = new Set<string>();
  for (const span of spans) agents.add(span.agent_id ?? "system");
  return [...agents].sort();
}

/** Fill by agent; a stroke marks non-ok status (color is never the only signal). */
export function spanClasses(agentIndex: number, status: SpanStatus): string {
  const base = agentClass(agentIndex);
  if (status === "error") return `${base} span-error`;
  if (status === "aborted") return `${base} span-aborted`;
  return base;
}

/** Make a chart bar keyboard-activatable and announce its meaning. */
export function makeInteractive(rect: SVGRectElement, label: string, onSelect: () => void): void {
  rect.setAttribute("tabindex", "0");
  rect.setAttribute("role", "button");
  rect.setAttribute("aria-label", label);
  rect.addEventListener("click", onSelect);
  rect.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  });
}
