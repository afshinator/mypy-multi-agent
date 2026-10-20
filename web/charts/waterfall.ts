import type { SpanRecord } from "../../shared/traceparent";
import type { SpanTrace } from "../lib/spans";
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

const LABEL_H = 20;

function lanesOf(spans: SpanRecord[]): string[] {
  const lanes: string[] = [];
  for (const span of spans) {
    const lane = span.agent_id ?? "system";
    if (!lanes.includes(lane)) lanes.push(lane);
  }
  return lanes;
}

/** Waterfall: bars by start_time, sized by duration, swimlaned by agent_id. */
export class WaterfallChart implements Chart {
  render(root: HTMLElement, trace: SpanTrace, onSelect: (span: SpanRecord) => void): void {
    root.replaceChildren();
    if (trace.spans.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No spans recorded.";
      root.append(empty);
      return;
    }

    const lanes = lanesOf(trace.spans);
    const laneSpans = new Map<string, SpanRecord[]>();
    for (const lane of lanes) {
      laneSpans.set(
        lane,
        trace.spans.filter((s) => (s.agent_id ?? "system") === lane),
      );
    }
    const total = Math.max(1, trace.maxEndMs - trace.minStartMs);
    const height = lanes.reduce(
      (acc, lane) => acc + LABEL_H + (laneSpans.get(lane)?.length ?? 0) * ROW_H,
      0,
    );

    const svg = svgRoot(MARGIN_LEFT + PLOT_W, height, "Trace waterfall");
    let laneTop = 0;
    const laneTops = new Map<string, number>();
    for (const lane of lanes) {
      laneTops.set(lane, laneTop);
      svg.append(svgText(MARGIN_LEFT - 8, laneTop + LABEL_H - 6, lane, "end"));
      laneTop += LABEL_H + (laneSpans.get(lane)?.length ?? 0) * ROW_H;
    }

    for (const lane of lanes) {
      (laneSpans.get(lane) ?? []).forEach((span, index) => {
        const startMs = span.start_time - trace.minStartMs;
        const durationMs = span.end_time === null ? 0 : span.end_time - span.start_time;
        const x = MARGIN_LEFT + (startMs / total) * PLOT_W;
        const w = Math.max(2, (durationMs / total) * PLOT_W);
        const y = (laneTops.get(lane) ?? 0) + LABEL_H + index * ROW_H;
        const rect = svgRect(x, y, w, ROW_H - 2, statusClass(span.status));
        makeInteractive(rect, `${span.name} (${span.status})`, () => onSelect(span));
        svg.append(rect);
        if (w > 60) svg.append(svgText(x + 4, y + ROW_H - 5, span.name));
      });
    }

    root.append(svg, renderSpanTable(trace));
  }
}
