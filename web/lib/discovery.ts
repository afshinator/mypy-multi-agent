import { parseFrontmatter } from "./frontmatter";

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface FileText {
  text: string;
  mtimeMs?: number;
}

/** Minimal directory surface so discovery stays pure and testable in-memory. */
export interface DirReader {
  list(path: string): Promise<DirEntry[]>;
  readText(path: string): Promise<FileText | null>;
}

export interface TaskRun {
  name: string;
  /** The `.mypi` container this task lives under; "" for the picked root. */
  project: string;
  runDetailsPath: string;
  startedAtMs?: number;
  /** Newest-artifact-mtime proxy for directory mtime (FSA has no directory mtime). */
  mtimeMs?: number;
  exitCode?: number;
  costUsd?: number;
}

export interface Project {
  name: string;
  tasks: TaskRun[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const joinPath = (base: string, name: string): string => (base === "" ? name : `${base}/${name}`);

const recencyMs = (t: TaskRun): number => t.startedAtMs ?? t.mtimeMs ?? 0;

const latestMs = (p: Project): number => (p.tasks[0] !== undefined ? recencyMs(p.tasks[0]) : 0);

function parseRunState(text: string): { startedAtMs?: number; costUsd?: number } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return {};
    const totals = isRecord(parsed.totals) ? parsed.totals : undefined;
    return {
      startedAtMs: typeof parsed.startedAtMs === "number" ? parsed.startedAtMs : undefined,
      costUsd:
        totals !== undefined && typeof totals.costUsd === "number" ? totals.costUsd : undefined,
    };
  } catch {
    return {};
  }
}

async function readTask(
  reader: DirReader,
  runDetailsPath: string,
  name: string,
  project: string,
): Promise<TaskRun> {
  const task: TaskRun = { name, project, runDetailsPath };
  const [state, final, conversation] = await Promise.all([
    reader.readText(joinPath(runDetailsPath, "run-state.json")),
    reader.readText(joinPath(runDetailsPath, "final.md")),
    reader.readText(joinPath(runDetailsPath, "conversation.jsonl")),
  ]);
  task.mtimeMs =
    Math.max(state?.mtimeMs ?? 0, final?.mtimeMs ?? 0, conversation?.mtimeMs ?? 0) || undefined;
  if (state !== null) {
    const parsed = parseRunState(state.text);
    task.startedAtMs = parsed.startedAtMs;
    task.costUsd = parsed.costUsd;
  }
  if (final !== null) {
    const fm = parseFrontmatter(final.text);
    if (typeof fm.exit_code === "number") task.exitCode = fm.exit_code;
  }
  return task;
}

async function scanMypi(reader: DirReader, mypiPath: string, project: string): Promise<Project> {
  const tasks: TaskRun[] = [];
  for (const entry of await reader.list(mypiPath)) {
    if (!entry.isDir) continue;
    const taskDir = joinPath(mypiPath, entry.name);
    const hasRunDetails = (await reader.list(taskDir)).some(
      (e) => e.isDir && e.name === "run-details",
    );
    if (!hasRunDetails) continue;
    tasks.push(await readTask(reader, joinPath(taskDir, "run-details"), entry.name, project));
  }
  tasks.sort((a, b) => recencyMs(b) - recencyMs(a));
  return { name: project, tasks };
}

/**
 * Discover `.mypi/` under the root plus one level of subdirectories. Each
 * `.mypi/<name>/` must contain `run-details/` to be listed. Returns projects
 * and tasks sorted most-recent-first.
 */
export async function discoverProjects(reader: DirReader, rootPath = ""): Promise<Project[]> {
  const candidates: Array<{ path: string; project: string }> = [];
  for (const entry of await reader.list(rootPath)) {
    if (!entry.isDir) continue;
    if (entry.name === ".mypi") {
      candidates.push({ path: joinPath(rootPath, entry.name), project: "" });
    } else if (!entry.name.startsWith(".")) {
      const subPath = joinPath(rootPath, entry.name);
      const hasMypi = (await reader.list(subPath)).some((e) => e.isDir && e.name === ".mypi");
      if (hasMypi) candidates.push({ path: joinPath(subPath, ".mypi"), project: entry.name });
    }
  }
  const projects: Project[] = [];
  for (const candidate of candidates) {
    const project = await scanMypi(reader, candidate.path, candidate.project);
    if (project.tasks.length > 0) projects.push(project);
  }
  projects.sort((a, b) => latestMs(b) - latestMs(a));
  return projects;
}
