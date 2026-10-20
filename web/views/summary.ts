import type { RunSummary } from "../lib/run-data";

const money = (n?: number): string => (n === undefined ? "—" : `$${n.toFixed(2)}`);
const count = (n?: number): string => (n === undefined ? "—" : n.toLocaleString());

function addStat(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  dl.append(dt, dd);
}

/** Summary view: outcome, exit code, totals, supervisor vs per-agent split. */
export function renderSummary(summary: RunSummary | null): HTMLElement {
  const section = document.createElement("section");
  section.className = "summary";

  const heading = document.createElement("h2");
  heading.textContent = "Run summary";
  section.append(heading);

  if (summary === null) {
    const missing = document.createElement("p");
    missing.className = "empty";
    missing.textContent =
      "Run summary not available (no final.md, scorecard.json, or run-state.json).";
    section.append(missing);
    return section;
  }

  const dl = document.createElement("dl");
  dl.className = "summary-stats";
  addStat(dl, "Outcome", summary.outcome);
  addStat(dl, "Exit code", summary.exitCode === undefined ? "—" : String(summary.exitCode));
  addStat(dl, "Total cost", money(summary.totalCostUsd));
  addStat(dl, "Total tokens", count(summary.totalTokens));
  addStat(dl, "Supervisor cost", money(summary.supervisorCostUsd));
  addStat(dl, "Supervisor tokens", count(summary.supervisorTokens));
  section.append(dl);

  if (summary.agents.length > 0) {
    const table = document.createElement("table");
    table.className = "agent-costs";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Agent", "Cost", "Tokens"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);

    const tbody = document.createElement("tbody");
    for (const agent of summary.agents) {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = agent.name;
      const cost = document.createElement("td");
      cost.textContent = money(agent.costUsd);
      const tokens = document.createElement("td");
      tokens.textContent = count(agent.tokens);
      row.append(name, cost, tokens);
      tbody.append(row);
    }
    table.append(thead, tbody);
    section.append(table);
  }

  return section;
}
