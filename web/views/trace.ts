import type { SpanRecord } from "../../shared/traceparent";
import { renderSpanTable } from "../charts/span-table";
import { WaterfallChart } from "../charts/waterfall";
import type { SpanTrace } from "../lib/spans";
import { summarizeTrace } from "../lib/summaries";
import { makeAccordion } from "./accordion";

function addStat(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  dl.append(dt, dd);
}

function fillDrawer(drawer: HTMLElement, span: SpanRecord): void {
  drawer.replaceChildren();

  const heading = document.createElement("h3");
  heading.textContent = `${span.name} (${span.span_id})`;
  drawer.append(heading);

  const dl = document.createElement("dl");
  dl.className = "span-details";
  addStat(dl, "Status", span.status);
  addStat(dl, "Kind", span.kind);
  addStat(dl, "Operation", span.operation_id ?? "—");
  addStat(
    dl,
    "Links",
    span.links.length === 0
      ? "—"
      : span.links.map((link) => `${link.span_id} — ${link.reason}`).join(", "),
  );
  addStat(dl, "Attributes", span.attributes === undefined ? "—" : JSON.stringify(span.attributes));
  drawer.append(dl);
}

/** Trace view: waterfall + nested tree, plus a span-detail drawer. */
export function renderTrace(trace: SpanTrace | null): HTMLElement {
  const section = document.createElement("section");
  section.className = "trace";

  const heading = document.createElement("h2");
  heading.textContent = "Trace";
  section.append(heading);

  if (trace === null) {
    const unavailable = document.createElement("p");
    unavailable.className = "empty";
    unavailable.textContent = "Trace not available (no spans.jsonl).";
    section.append(unavailable);
    return section;
  }

  const drawer = document.createElement("aside");
  drawer.className = "span-drawer";
  drawer.hidden = true;
  drawer.setAttribute("aria-label", "Span details");

  const onSelect = (span: SpanRecord): void => {
    fillDrawer(drawer, span);
    drawer.hidden = false;
  };

  const waterfallHeading = document.createElement("h3");
  waterfallHeading.textContent = "Waterfall";
  const waterfall = document.createElement("div");
  waterfall.className = "chart";

  new WaterfallChart().render(waterfall, trace, onSelect);

  section.append(waterfallHeading, waterfall, renderSpanTable(trace), drawer);

  makeAccordion(section, summarizeTrace(trace), "accordion-trace");
  return section;
}
