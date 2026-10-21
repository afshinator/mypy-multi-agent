import { type DiscoveredTask, discoverProjects } from "../lib/discovery";
import { buildNodeGraph } from "../lib/node-graph";
import { loadPlanFindings } from "../lib/plan-findings";
import type { DirReader } from "../lib/reader";
import { loadPeerRoster } from "../lib/roster";
import { loadRunData } from "../lib/run-data";
import { loadSpanTrace } from "../lib/spans";
import { loadTimeline } from "../lib/timeline";
import { loadToolCalls } from "../lib/tool-calls";
import { renderDoD } from "../views/dod";
import { renderNodeGraphView } from "../views/node-graph";
import { renderPlanFindings } from "../views/plan-findings";
import { renderRoster } from "../views/roster";
import { renderSummary } from "../views/summary";
import { renderTimeline } from "../views/timeline";
import { renderToolCalls } from "../views/tool-calls";
import { renderTrace } from "../views/trace";
import {
  createFallbackDirReader,
  createHandleDirReader,
  loadPersistedRoots,
  type ProjectRoot,
  persistRoot,
  pickProjectRoot,
  removeRoot,
} from "./fsa";

interface OpenProject {
  root: ProjectRoot;
  reader: DirReader;
  tasks: DiscoveredTask[];
}

function getElement<T extends Element>(id: string): T {
  const el = document.querySelector<T>(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

const mainPane = getElement<HTMLElement>("#main");
const sidebar = getElement<HTMLElement>("#project-list");
const tabbar = document.createElement("div");
tabbar.className = "project-tabs";
tabbar.setAttribute("role", "tablist");
tabbar.setAttribute("aria-label", "Open projects");

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

const addProjectButton = getElement<HTMLButtonElement>("#add-project");
addProjectButton.addEventListener("click", () => void addRoot());

let projects: OpenProject[] = [];
let activeRootId: string | null = null;
let activeTaskName: string | null = null;
let renderSeq = 0;

function readerFor(root: ProjectRoot): DirReader {
  if (root.handle !== null) return createHandleDirReader(root.handle);
  return createFallbackDirReader(root.files ?? []);
}

async function buildOpenProject(root: ProjectRoot): Promise<OpenProject> {
  const reader = readerFor(root);
  const tasks = await discoverProjects(reader, "");
  tasks.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { root, reader, tasks };
}

const activeProject = (): OpenProject | null =>
  projects.find((p) => p.root.id === activeRootId) ?? null;

const activeTask = (project: OpenProject): DiscoveredTask | null =>
  project.tasks.find((t) => t.name === activeTaskName) ?? null;

function renderAll(): void {
  renderSeq += 1;
  renderTabs();
  renderSidebar();
  void renderViews();
}

function renderTabs(): void {
  tabbar.replaceChildren();
  for (const project of projects) {
    const tab = document.createElement("div");
    tab.className = "project-tab";
    tab.setAttribute("role", "tab");
    tab.id = `tab-${project.root.id}`;
    tab.tabIndex = project.root.id === activeRootId ? 0 : -1;
    tab.setAttribute("aria-selected", String(project.root.id === activeRootId));

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = project.root.name;
    tab.append(label);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.setAttribute("aria-label", `Close ${project.root.name}`);
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeRoot(project.root.id);
    });
    tab.append(close);

    tab.addEventListener("click", () => setActiveRoot(project.root.id));
    tab.addEventListener("keydown", (event) => onTabKeydown(event, project.root.id));
    tabbar.append(tab);
  }
}

function onTabKeydown(event: KeyboardEvent, id: string): void {
  const index = projects.findIndex((p) => p.root.id === id);
  let target = -1;
  if (event.key === "ArrowRight") target = index + 1;
  else if (event.key === "ArrowLeft") target = index - 1;
  else if (event.key === "Home") target = 0;
  else if (event.key === "End") target = projects.length - 1;
  else return;

  event.preventDefault();
  const next = projects[target];
  if (next === undefined) return;
  setActiveRoot(next.root.id);
  document.getElementById(`tab-${next.root.id}`)?.focus();
}

function renderSidebar(): void {
  sidebar.replaceChildren();
  for (const project of projects) {
    const group = document.createElement("div");
    group.className = "project-group";

    const header = document.createElement("div");
    header.className = "project-root";

    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.root.name;
    name.title = project.root.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "project-remove";
    remove.setAttribute("aria-label", `Remove ${project.root.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => void closeRoot(project.root.id));

    header.append(name, remove);
    group.append(header);

    if (project.tasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No runs (missing config or no run-details/).";
      group.append(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "task-list";
      for (const task of project.tasks) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "task-button";
        if (project.root.id === activeRootId && task.name === activeTaskName) {
          button.classList.add("task-selected");
        }
        const taskName = document.createElement("span");
        taskName.className = "task-name";
        taskName.textContent = task.name;
        button.append(taskName);
        button.addEventListener("click", () => setActiveTask(project.root.id, task.name));
        li.append(button);
        list.append(li);
      }
      group.append(list);
    }

    sidebar.append(group);
  }
}

function emptyView(message: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "summary";
  const heading = document.createElement("h2");
  heading.textContent = "Run inspector";
  const notice = document.createElement("p");
  notice.className = "empty";
  notice.textContent = message;
  section.append(heading, notice);
  return section;
}

async function renderViews(): Promise<void> {
  const seq = renderSeq;
  const project = activeProject();

  if (project === null) {
    mainPane.replaceChildren(tabbar, emptyView("Add a project root to inspect its runs."));
    return;
  }
  const task = activeTask(project);
  if (task === null) {
    mainPane.replaceChildren(
      tabbar,
      emptyView(`No runs found for ${project.root.name} (missing config or no run-details/).`),
    );
    return;
  }

  const reader = project.reader;
  const runDetailsPath = task.runDetailsPath;
  const [data, timeline, toolCalls, roster, trace, planFindings] = await Promise.all([
    loadRunData(reader, runDetailsPath),
    loadTimeline(reader, runDetailsPath),
    loadToolCalls(reader, runDetailsPath),
    loadPeerRoster(reader, runDetailsPath),
    loadSpanTrace(reader, runDetailsPath),
    loadPlanFindings(reader, runDetailsPath),
  ]);
  if (seq !== renderSeq) return;

  const nodeGraph = timeline === null ? null : buildNodeGraph(timeline);
  mainPane.replaceChildren(
    tabbar,
    renderSummary(data.hasSummary ? data.summary : null),
    renderDoD(data.hasFinalMd ? data.criteria : null),
    renderTimeline(timeline),
    renderNodeGraphView(nodeGraph),
    renderToolCalls(toolCalls),
    renderRoster(roster),
    renderTrace(trace),
    renderPlanFindings(planFindings),
  );
}

function setActiveRoot(id: string): void {
  activeRootId = id;
  const project = activeProject();
  activeTaskName = project?.tasks[0]?.name ?? null;
  renderAll();
}

function setActiveTask(rootId: string, taskName: string): void {
  activeRootId = rootId;
  activeTaskName = taskName;
  renderAll();
}

async function closeRoot(id: string): Promise<void> {
  const index = projects.findIndex((p) => p.root.id === id);
  if (index === -1) return;
  const [removed] = projects.splice(index, 1);
  if (removed?.root.handle !== null) {
    await removeRoot(id);
  }
  if (activeRootId === id) {
    activeRootId = projects[0]?.root.id ?? null;
    activeTaskName = projects[0]?.tasks[0]?.name ?? null;
  }
  renderAll();
}

async function addRoot(): Promise<void> {
  const root = await pickProjectRoot();
  if (root === null) return;

  const existing = projects.find((p) => p.root.name === root.name);
  if (existing !== undefined) {
    setActiveRoot(existing.root.id);
    return;
  }

  const project = await buildOpenProject(root);
  projects.push(project);
  if (root.handle !== null) await persistRoot(root);
  activeRootId = root.id;
  activeTaskName = project.tasks[0]?.name ?? null;
  renderAll();
}

async function launch(): Promise<void> {
  const persisted = await loadPersistedRoots();
  projects = await Promise.all(persisted.map(buildOpenProject));
  activeRootId = projects[0]?.root.id ?? null;
  activeTaskName = projects[0]?.tasks[0]?.name ?? null;
  renderAll();
}

void launch();
