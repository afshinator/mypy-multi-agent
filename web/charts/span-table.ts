import type { SpanTrace } from "../lib/spans";

/** Screen-reader data-table fallback for each chart (visually hidden). */
export function renderSpanTable(trace: SpanTrace): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "sr-only";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Name", "Agent", "Kind", "Status", "Start (ms)", "Duration (ms)"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const row of trace.waterfall) {
    const span = row.span;
    const tr = document.createElement("tr");
    for (const value of [
      span.name,
      span.agent_id ?? "—",
      span.kind,
      span.status,
      String(span.start_time),
      String(row.durationMs),
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}
