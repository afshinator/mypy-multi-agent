import type { DirReader } from "../lib/discovery";
import { discoverProjects, type Project, type TaskRun } from "../lib/discovery";
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
import { FsaDirReader, loadProjects, type ProjectRoot, pickProject, requestRestore } from "./fsa";

function getElement<T extends Element>(id: string): T {
  const el = document.querySelector<T>(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

const sidebar = getElement<HTMLElement>("#project-list");
const mainPane = getElement<HTMLElement>("#main");
const addBtn = getElement<HTMLButtonElement>("#add-project");
const restoreBtn = getElement<HTMLButtonElement>("#restore-projects");

interface LoadedRoot {
  root: ProjectRoot;
  reader: DirReader;
  projects: Project[];
}

const loaded: LoadedRoot[] = [];
let selectedTask: TaskRun | null = null;
let selectedReader: DirReader | null = null;
let renderToken = 0;

const recencyMs = (t: TaskRun): number => t.startedAtMs ?? t.mtimeMs ?? 0;

function badge(task: TaskRun): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "badge";
  if (task.exitCode === 0) {
    span.classList.add("badge-pass");
    span.textContent = "exit 0";
  } else if (task.exitCode !== undefined) {
    span.classList.add("badge-fail");
    span.textContent = `exit ${task.exitCode}`;
  } else {
    span.classList.add("badge-unknown");
    span.textContent = "unknown";
  }
  return span;
}

function costLabel(task: TaskRun): string {
  return task.costUsd === undefined ? "—" : `$${task.costUsd.toFixed(2)}`;
}

function renderSidebar(): void {
  sidebar.replaceChildren();
  for (const entry of loaded) {
    const rootHeader = document.createElement("div");
    rootHeader.className = "project-root";
    rootHeader.textContent = entry.root.name;
    sidebar.append(rootHeader);

    for (const project of entry.projects) {
      const projectHeader = document.createElement("div");
      projectHeader.className = "project-name";
      projectHeader.textContent = project.name === "" ? ".mypi" : `${project.name}/.mypi`;
      sidebar.append(projectHeader);

      const ul = document.createElement("ul");
      ul.className = "task-list";
      for (const task of project.tasks) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "task-button";
        if (task === selectedTask) button.classList.add("task-selected");
        button.append(badge(task));

        const name = document.createElement("span");
        name.className = "task-name";
        name.textContent = task.name;
        button.append(name);

        const cost = document.createElement("span");
        cost.className = "task-cost";
        cost.textContent = costLabel(task);
        button.append(cost);

        button.addEventListener("click", () => {
          selectedTask = task;
          selectedReader = entry.reader;
          render();
        });
        li.append(button);
        ul.append(li);
      }
      sidebar.append(ul);
    }
  }
}

async function renderMain(): Promise<void> {
  const token = ++renderToken;
  mainPane.replaceChildren();
  if (selectedTask === null || selectedReader === null) {
    const empty = document.createElement("p");
    empty.className = "empty";
    if (loaded.length === 0) {
      empty.textContent = "Pick a project to inspect its runs.";
      mainPane.append(empty);
    } else if (!loaded.some((entry) => entry.projects.some((p) => p.tasks.length > 0))) {
      empty.textContent = "No .mypi runs found in the picked directories.";
      const pickButton = document.createElement("button");
      pickButton.type = "button";
      pickButton.textContent = "Pick another directory";
      pickButton.addEventListener("click", () => void addPicked());
      mainPane.append(empty, pickButton);
    } else {
      empty.textContent = "Select a task to inspect its run.";
      mainPane.append(empty);
    }
    return;
  }
  const [data, timeline, toolCalls, roster, trace, planFindings] = await Promise.all([
    loadRunData(selectedReader, selectedTask.runDetailsPath),
    loadTimeline(selectedReader, selectedTask.runDetailsPath),
    loadToolCalls(selectedReader, selectedTask.runDetailsPath),
    loadPeerRoster(selectedReader, selectedTask.runDetailsPath),
    loadSpanTrace(selectedReader, selectedTask.runDetailsPath),
    loadPlanFindings(selectedReader, selectedTask.runDetailsPath),
  ]);
  if (token !== renderToken) return; // a newer selection superseded this load
  mainPane.append(
    renderSummary(data.hasSummary ? data.summary : null),
    renderDoD(data.hasFinalMd ? data.criteria : null),
    renderTimeline(timeline),
    renderToolCalls(toolCalls),
    renderRoster(roster),
    renderTrace(trace),
    renderPlanFindings(planFindings),
  );
}

function render(): void {
  renderSidebar();
  void renderMain();
}

function selectMostRecent(): void {
  let bestTask: TaskRun | null = null;
  let bestReader: DirReader | null = null;
  let bestMs = -1;
  for (const entry of loaded) {
    for (const project of entry.projects) {
      const task = project.tasks[0];
      if (task !== undefined && recencyMs(task) > bestMs) {
        bestMs = recencyMs(task);
        bestTask = task;
        bestReader = entry.reader;
      }
    }
  }
  selectedTask = bestTask;
  selectedReader = bestReader;
}

async function addRoot(root: ProjectRoot): Promise<void> {
  if (loaded.some((entry) => entry.root.id === root.id)) return;
  const reader = new FsaDirReader(root.handle);
  const projects = await discoverProjects(reader);
  loaded.push({ root, reader, projects });
}

async function addPicked(): Promise<void> {
  const root = await pickProject();
  if (root !== null) {
    await addRoot(root);
    render();
  }
}

async function restoreSaved(): Promise<void> {
  for (const root of await requestRestore()) {
    await addRoot(root);
  }
  render();
}

addBtn.addEventListener("click", () => {
  void addPicked();
});
restoreBtn.addEventListener("click", () => {
  void restoreSaved();
});

void (async () => {
  try {
    for (const root of await loadProjects()) {
      await addRoot(root);
    }
  } catch (error) {
    console.error("project restore failed", error);
  }
  selectMostRecent();
  render();
})();
