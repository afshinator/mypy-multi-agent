import type { RunScorecard } from "../lib/scorecard";
import { makeAccordion } from "./accordion";

const fmtMs = (ms: number): string => `${ms.toLocaleString()} ms`;
const money = (n: number | null): string => (n === null ? "—" : `$${n.toFixed(2)}`);
const count = (n: number | null): string => (n === null ? "—" : n.toLocaleString());

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

function summarizeDurations(values: number[]): {
  count: number;
  avg: number;
  min: number;
  max: number;
} {
  if (values.length === 0) return { count: 0, avg: 0, min: 0, max: 0 };
  const total = values.reduce((acc, v) => acc + v, 0);
  return {
    count: values.length,
    avg: total / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function summarizeHealth(scorecard: RunScorecard): string {
  return `${scorecard.outcome ?? "unknown"} · exit ${scorecard.exitCode ?? "—"} · ${scorecard.toolCalls} tool calls`;
}

/** Health view: readable summary of the run scorecard, never raw JSON. */
export function renderHealth(scorecard: RunScorecard | null): HTMLElement {
  const section = document.createElement("section");
  section.className = "health";

  const heading = document.createElement("h2");
  heading.textContent = "Health";
  section.append(heading);

  if (scorecard === null) {
    const missing = document.createElement("p");
    missing.className = "empty";
    missing.textContent = "Health not available";
    section.append(missing);
    makeAccordion(section, "Health not available", "accordion-health");
    return section;
  }

  const dl = document.createElement("dl");
  dl.className = "summary-stats";
  addStat(dl, "Outcome", scorecard.outcome ?? "—");
  addStat(dl, "Exit code", scorecard.exitCode === null ? "—" : String(scorecard.exitCode));
  addStat(dl, "Outcome/exit mismatch", scorecard.outcomeExitMismatch ? "yes" : "no");
  addStat(dl, "DoD", scorecard.dod);
  addStat(dl, "False success", scorecard.falseSuccess ? "yes" : "no");
  addStat(dl, "Tool calls", count(scorecard.toolCalls));
  addStat(dl, "Tool errors", count(scorecard.toolErrors));
  addStat(dl, "Tool time", fmtMs(scorecard.toolTimeMs));
  addStat(dl, "Retries", count(scorecard.retries));
  addStat(dl, "Correlation timeouts", count(scorecard.correlationTimeouts));
  addStat(dl, "Crashed", count(scorecard.agentCrashed));
  addStat(dl, "Unusable", count(scorecard.agentUnusable));
  addStat(dl, "Stalled", count(scorecard.agentStalled));
  section.append(dl);

  const turnAgents = Object.keys(scorecard.turnDurationsMs).sort();
  if (turnAgents.length > 0) {
    const subHeading = document.createElement("h3");
    subHeading.textContent = "Turn durations";
    section.append(subHeading);

    const table = document.createElement("table");
    table.className = "health-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Agent", "Turns", "Avg", "Min", "Max"]) headRow.append(th(label));
    thead.append(headRow);

    const tbody = document.createElement("tbody");
    for (const agent of turnAgents) {
      const stats = summarizeDurations(scorecard.turnDurationsMs[agent] ?? []);
      const row = document.createElement("tr");
      for (const value of [
        agent,
        String(stats.count),
        fmtMs(Math.round(stats.avg)),
        fmtMs(stats.min),
        fmtMs(stats.max),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      tbody.append(row);
    }
    table.append(thead, tbody);
    section.append(table);
  }

  const toolAgents = Object.keys(scorecard.toolTimeByAgentMs).sort();
  if (toolAgents.length > 0) {
    const subHeading = document.createElement("h3");
    subHeading.textContent = "Tool time by agent";
    section.append(subHeading);

    const table = document.createElement("table");
    table.className = "health-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.append(th("Agent"), th("Tool time"));
    thead.append(headRow);

    const tbody = document.createElement("tbody");
    for (const agent of toolAgents) {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = agent;
      const value = document.createElement("td");
      value.textContent = fmtMs(scorecard.toolTimeByAgentMs[agent] ?? 0);
      row.append(name, value);
      tbody.append(row);
    }
    table.append(thead, tbody);
    section.append(table);
  }

  const reasons = Object.entries(scorecard.stopAgentReasons).sort();
  const stopHeading = document.createElement("h3");
  stopHeading.textContent = "Stop agent reasons";
  section.append(stopHeading);
  if (reasons.length === 0) {
    const none = document.createElement("p");
    none.className = "empty";
    none.textContent = "None recorded";
    section.append(none);
  } else {
    const reasonsDl = document.createElement("dl");
    reasonsDl.className = "stop-reasons";
    for (const [reason, value] of reasons) addStat(reasonsDl, reason, String(value));
    section.append(reasonsDl);
  }

  const mistakesHeading = document.createElement("h3");
  mistakesHeading.textContent = "Mistakes";
  section.append(mistakesHeading);
  if (scorecard.mistakes.length === 0) {
    const none = document.createElement("p");
    none.className = "empty";
    none.textContent = "None recorded";
    section.append(none);
  } else {
    const list = document.createElement("ul");
    list.className = "mistake-list";
    for (const mistake of scorecard.mistakes) {
      const li = document.createElement("li");
      li.textContent = `${mistake.class}: ${mistake.detail}`;
      list.append(li);
    }
    section.append(list);
  }

  const costHeading = document.createElement("h3");
  costHeading.textContent = "Cost";
  section.append(costHeading);

  const costDl = document.createElement("dl");
  costDl.className = "cost-stats";
  addStat(costDl, "Total cost", money(scorecard.cost.totalCostUsd));
  addStat(costDl, "Total tokens", count(scorecard.cost.totalTokens));
  addStat(costDl, "Supervisor cost", money(scorecard.cost.supervisorCostUsd));
  addStat(costDl, "Supervisor tokens", count(scorecard.cost.supervisorTokens));
  section.append(costDl);

  if (scorecard.cost.agents.length > 0) {
    const table = document.createElement("table");
    table.className = "health-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.append(th("Agent"), th("Cost"), th("Tokens"));
    thead.append(headRow);

    const tbody = document.createElement("tbody");
    for (const agent of scorecard.cost.agents) {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = agent.agentId;
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

  makeAccordion(section, summarizeHealth(scorecard), "accordion-health");
  return section;
}
