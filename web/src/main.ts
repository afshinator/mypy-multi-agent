import { DummyDirReader, dummyRunDetailsPath } from "../lib/dummy-run";
import { loadPlanFindings } from "../lib/plan-findings";
import { loadPeerRoster } from "../lib/roster";
import { loadRunData } from "../lib/run-data";
import { loadSpanTrace } from "../lib/spans";
import { loadTimeline } from "../lib/timeline";
import { loadToolCalls } from "../lib/tool-calls";
import { renderDoD } from "../views/dod";
import { renderPlanFindings } from "../views/plan-findings";
import { renderRoster } from "../views/roster";
import { renderSummary } from "../views/summary";
import { renderTimeline } from "../views/timeline";
import { renderToolCalls } from "../views/tool-calls";
import { renderTrace } from "../views/trace";

const reader = new DummyDirReader();

function getElement<T extends Element>(id: string): T {
  const el = document.querySelector<T>(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

const mainPane = getElement<HTMLElement>("#main");
const sidebar = getElement<HTMLElement>("#project-list");

const themeToggle = getElement<HTMLButtonElement>("#theme-toggle");
themeToggle.addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  localStorage.setItem("theme", next);
  themeToggle.textContent = next === "dark" ? "Light mode" : "Dark mode";
});
themeToggle.textContent =
  document.documentElement.dataset.theme === "dark" ? "Light mode" : "Dark mode";

const sidebarToggle = getElement<HTMLButtonElement>("#sidebar-toggle");

const applySidebar = (collapsed: boolean): void => {
  document.documentElement.classList.toggle("sidebar-collapsed", collapsed);
  sidebarToggle.textContent = collapsed ? "»" : "«";
  sidebarToggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
};

sidebarToggle.addEventListener("click", () => {
  const collapsed = !document.documentElement.classList.contains("sidebar-collapsed");
  localStorage.setItem("sidebar", collapsed ? "collapsed" : "expanded");
  applySidebar(collapsed);
});

applySidebar(document.documentElement.classList.contains("sidebar-collapsed"));

function renderSidebar(): void {
  sidebar.replaceChildren();
  const header = document.createElement("div");
  header.className = "project-name";
  header.textContent = "dummy-run";
  sidebar.append(header);
  const task = document.createElement("button");
  task.type = "button";
  task.className = "task-button";
  task.textContent = "sample task";
  sidebar.append(task);
}

async function render(): Promise<void> {
  const [data, timeline, toolCalls, roster, trace, planFindings] = await Promise.all([
    loadRunData(reader, dummyRunDetailsPath),
    loadTimeline(reader, dummyRunDetailsPath),
    loadToolCalls(reader, dummyRunDetailsPath),
    loadPeerRoster(reader, dummyRunDetailsPath),
    loadSpanTrace(reader, dummyRunDetailsPath),
    loadPlanFindings(reader, dummyRunDetailsPath),
  ]);
  mainPane.replaceChildren(
    renderSummary(data.hasSummary ? data.summary : null),
    renderDoD(data.hasFinalMd ? data.criteria : null),
    renderTimeline(timeline),
    renderToolCalls(toolCalls),
    renderRoster(roster),
    renderTrace(trace),
    renderPlanFindings(planFindings),
  );
}

renderSidebar();
void render();
