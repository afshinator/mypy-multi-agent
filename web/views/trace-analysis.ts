import type { TraceAnalysis } from "../lib/trace-analysis";
import { makeAccordion } from "./accordion";

const fmtMs = (ms: number): string => `${ms.toLocaleString()} ms`;

function addStat(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  dl.append(dt, dd);
}

function th(text: string): HTMLTableCellElement {
  const el = document.createElement("th");
  el.scope = "col";
  el.textContent = text;
  return el;
}

function summarize(analysis: TraceAnalysis): string {
  const critical = analysis.criticalPath;
  const parallelism = analysis.parallelismFactor;
  if (critical === null && parallelism === null) return "No spans recorded";
  return `critical path ${critical === null ? "—" : fmtMs(critical.durationMs)} · parallelism ${parallelism === null ? "—" : parallelism.toFixed(2)}`;
}

/** Trace analysis view: critical path, parallelism, idle time, supervisor latency. */
export function renderTraceAnalysis(analysis: TraceAnalysis): HTMLElement {
  const section = document.createElement("section");
  section.className = "trace-analysis";

  const heading = document.createElement("h2");
  heading.textContent = "Trace analysis";
  section.append(heading);

  const dl = document.createElement("dl");
  dl.className = "summary-stats";
  addStat(
    dl,
    "Critical path",
    analysis.criticalPath === null ? "—" : analysis.criticalPath.spanIds.join(" → "),
  );
  addStat(
    dl,
    "Critical path duration",
    analysis.criticalPath === null ? "—" : fmtMs(analysis.criticalPath.durationMs),
  );
  addStat(
    dl,
    "Parallelism factor",
    analysis.parallelismFactor === null ? "—" : analysis.parallelismFactor.toFixed(2),
  );
  section.append(dl);

  const idleAgents = Object.entries(analysis.agentIdleTime);
  if (idleAgents.length > 0) {
    const subHeading = document.createElement("h3");
    subHeading.textContent = "Per-agent idle time";
    section.append(subHeading);

    const table = document.createElement("table");
    table.className = "idle-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Agent", "Wall", "Active", "Idle"]) headRow.append(th(label));
    thead.append(headRow);

    const tbody = document.createElement("tbody");
    for (const [agent, idle] of idleAgents) {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = agent;
      const wall = document.createElement("td");
      wall.textContent = fmtMs(idle.wallMs);
      const active = document.createElement("td");
      active.textContent = fmtMs(idle.activeMs);
      const idleCell = document.createElement("td");
      idleCell.textContent = fmtMs(idle.idleMs);
      row.append(name, wall, active, idleCell);
      tbody.append(row);
    }
    table.append(thead, tbody);
    section.append(table);
  }

  const gaps = analysis.supervisorLatency;
  const latencyHeading = document.createElement("h3");
  latencyHeading.textContent = "Supervisor latency";
  section.append(latencyHeading);

  if (gaps.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No FINAL_REPORT → WORK_ORDER gaps recorded.";
    section.append(empty);
  } else {
    const avg = gaps.reduce((acc, gap) => acc + gap, 0) / gaps.length;
    const max = Math.max(...gaps);
    const summary = document.createElement("p");
    summary.textContent = `${gaps.length} gaps · avg ${fmtMs(Math.round(avg))} · max ${fmtMs(max)}`;
    section.append(summary);

    const list = document.createElement("ul");
    list.className = "latency-list";
    for (const gap of gaps) {
      const li = document.createElement("li");
      li.textContent = fmtMs(gap);
      list.append(li);
    }
    section.append(list);
  }

  makeAccordion(section, summarize(analysis), "accordion-trace-analysis");
  return section;
}
