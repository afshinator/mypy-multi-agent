import type { SpanRecord } from "../../shared/traceparent";
import type { SpanTrace, SpanTree } from "../lib/spans";
import type { Chart } from "./chart";
import { renderSpanTable } from "./span-table";
import {
  MARGIN_LEFT,
  makeInteractive,
  PLOT_W,
  ROW_H,
  statusClass,
  svgRect,
  svgRoot,
  svgText,
} from "./svg";

/** Nested tree: flame graph via parent_span_id, depth on the y-axis. */
export class TreeChart implements Chart {
  render(root: HTMLElement, trace: SpanTrace, onSelect: (span: SpanRecord) => void): void {
    root.replaceChildren();
    if (trace.spans.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No spans recorded.";
      root.append(empty);
      return;
    }

    const total = Math.max(1, trace.maxEndMs - trace.minStartMs);
    const maxDepth = trace.waterfall.reduce((acc, row) => Math.max(acc, row.depth), 0);
    const height = (maxDepth + 1) * ROW_H + 4;
    const svg = svgRoot(MARGIN_LEFT + PLOT_W, height, "Nested span tree");

    const renderNode = (node: SpanTree, depth: number): void => {
      const span = node.span;
      const startMs = span.start_time - trace.minStartMs;
      const durationMs = span.end_time === null ? 0 : span.end_time - span.start_time;
      const x = MARGIN_LEFT + (startMs / total) * PLOT_W;
      const w = Math.max(2, (durationMs / total) * PLOT_W);
      const y = depth * ROW_H;
      const rect = svgRect(x, y, w, ROW_H - 2, statusClass(span.status));
      makeInteractive(rect, `${span.name} (${span.status})`, () => onSelect(span));
      svg.append(rect);
      if (w > 60) svg.append(svgText(x + 4, y + ROW_H - 5, span.name));
      for (const child of node.children) renderNode(child, depth + 1);
    };
    for (const node of trace.roots) renderNode(node, 0);

    root.append(svg, renderSpanTable(trace));
  }
}
