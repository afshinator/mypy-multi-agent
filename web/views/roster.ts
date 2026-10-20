import type { Peer, PeerRoster } from "../lib/roster";

const money = (n: number): string => `$${n.toFixed(2)}`;
const count = (n: number): string => n.toLocaleString();

function th(text: string): HTMLTableCellElement {
  const el = document.createElement("th");
  el.scope = "col";
  el.textContent = text;
  return el;
}

function budgetCell(
  usage: number | undefined,
  max: number | undefined,
  label: string,
  format: (n: number) => string,
): HTMLTableCellElement {
  const td = document.createElement("td");
  if (usage === undefined) {
    td.textContent = "—";
    return td;
  }
  const text = document.createElement("span");
  text.className = "budget-text";
  text.textContent = max === undefined ? format(usage) : `${format(usage)} / ${format(max)}`;
  td.append(text);
  if (max !== undefined && max > 0) {
    const bar = document.createElement("progress");
    bar.className = "budget-bar";
    bar.max = max;
    bar.value = Math.min(usage, max);
    bar.setAttribute("aria-label", label);
    td.append(bar);
  }
  return td;
}

function stateCell(state: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = `peer-state state-${state.toLowerCase()}`;
  td.textContent = state;
  return td;
}

/** Peer roster: state, model, usage-vs-budget bars, last completed work order. */
export function renderRoster(roster: PeerRoster | null): HTMLElement {
  const section = document.createElement("section");
  section.className = "roster";

  const heading = document.createElement("h2");
  heading.textContent = "Peer roster";
  section.append(heading);

  if (roster === null) {
    const missing = document.createElement("p");
    missing.className = "empty";
    missing.textContent = "Peer roster not available (no run-state.json).";
    section.append(missing);
    return section;
  }

  if (roster.peers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No peers recorded.";
    section.append(empty);
    return section;
  }

  const table = document.createElement("table");
  table.className = "roster-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Agent", "State", "Model", "Cost", "Tokens", "Last work order"]) {
    headRow.append(th(label));
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const peer of roster.peers) {
    tbody.append(row(peer));
  }
  table.append(thead, tbody);
  section.append(table);
  return section;
}

function row(peer: Peer): HTMLTableRowElement {
  const tr = document.createElement("tr");

  const id = document.createElement("td");
  id.textContent = peer.id;
  id.className = "peer-id";

  const model = document.createElement("td");
  model.className = "peer-model";
  model.textContent = peer.model ?? "—";

  const workOrder = document.createElement("td");
  workOrder.textContent = peer.lastCompletedWorkOrder ?? "—";

  tr.append(
    id,
    stateCell(peer.state),
    model,
    budgetCell(peer.usageCostUsd, peer.maxCostUsd, `${peer.id} cost budget`, money),
    budgetCell(peer.usageTokens, peer.maxTokens, `${peer.id} token budget`, count),
    workOrder,
  );
  return tr;
}
