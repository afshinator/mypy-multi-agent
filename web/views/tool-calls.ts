import type { ToolCall } from "../lib/tool-calls";

const fmtTime = (ts: number): string => new Date(ts).toLocaleTimeString();

function th(text: string): HTMLTableCellElement {
  const el = document.createElement("th");
  el.scope = "col";
  el.textContent = text;
  return el;
}

/** Tool-call table with truncated, click-to-expand args. */
export function renderToolCalls(calls: ToolCall[] | null): HTMLElement {
  const section = document.createElement("section");
  section.className = "tool-calls";

  const heading = document.createElement("h2");
  heading.textContent = "Tool calls";
  section.append(heading);

  if (calls === null) {
    const missing = document.createElement("p");
    missing.className = "empty";
    missing.textContent = "Tool calls not available (no tool-calls.jsonl).";
    section.append(missing);
    return section;
  }

  if (calls.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No tool calls recorded.";
    section.append(empty);
    return section;
  }

  const table = document.createElement("table");
  table.className = "tool-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Timestamp", "Agent", "Tool", "Args", "Duration", "Error"]) {
    headRow.append(th(label));
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const call of calls) {
    const row = document.createElement("tr");

    const time = document.createElement("td");
    time.className = "tool-time";
    time.textContent = fmtTime(call.timestamp);

    const agent = document.createElement("td");
    agent.textContent = call.agentId;

    const tool = document.createElement("td");
    tool.textContent = call.toolName;

    const args = document.createElement("td");
    args.className = "tool-args";
    const argsText = document.createElement("span");
    argsText.className = "args-text";
    argsText.textContent = call.argsText;
    args.append(argsText);
    if (call.argsText.length > 80) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "args-toggle";
      toggle.textContent = "expand";
      toggle.addEventListener("click", () => {
        const expanded = args.classList.toggle("args-expanded");
        toggle.textContent = expanded ? "collapse" : "expand";
      });
      args.append(toggle);
    }

    const duration = document.createElement("td");
    duration.className = "tool-duration";
    duration.textContent = call.durationMs === undefined ? "—" : `${call.durationMs}ms`;

    const error = document.createElement("td");
    error.className = call.isError ? "tool-error" : "tool-ok";
    error.textContent = call.isError ? "error" : "ok";

    row.append(time, agent, tool, args, duration, error);
    tbody.append(row);
  }
  table.append(thead, tbody);
  section.append(table);
  return section;
}
