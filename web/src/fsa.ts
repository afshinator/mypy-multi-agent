/**
 * Browser-only project-root access: File System Access API picker, IndexedDB
 * persistence (`run-inspector` / `projects`), permission re-grant, and a
 * `webkitdirectory` input fallback. Nothing here is imported by tests.
 */
import type { DirEntry, DirReader } from "../lib/reader";

export interface ProjectRoot {
  id: string;
  name: string;
  /** FSA directory handle; null when the webkitdirectory fallback supplied it. */
  handle: FileSystemDirectoryHandle | null;
  /** webkitdirectory fallback files; set only when handle is null. */
  files: File[] | null;
}

const DB_NAME = "run-inspector";
const STORE = "projects";

interface PersistedProject {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAll(db: IDBDatabase): Promise<PersistedProject[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as PersistedProject[]);
    request.onerror = () => reject(request.error);
  });
}

function put(db: IDBDatabase, value: PersistedProject): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function del(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** Ask for read permission on a restored handle; false when it cannot be granted. */
async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    if ((await handle.queryPermission({ mode: "read" })) === "granted") return true;
    return (await handle.requestPermission({ mode: "read" })) === "granted";
  } catch {
    // requestPermission without a user gesture can reject; skip that root.
    return false;
  }
}

/** Persisted roots with read permission re-granted on restore. */
export async function loadPersistedRoots(): Promise<ProjectRoot[]> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return [];
  }
  const records = await getAll(db);
  const roots: ProjectRoot[] = [];
  for (const record of records) {
    if (record.handle === undefined) continue;
    if (!(await ensurePermission(record.handle))) continue;
    roots.push({ id: record.id, name: record.name, handle: record.handle, files: null });
  }
  return roots;
}

/** Persist a root. Fallback roots have no handle to re-open, so they are session-only. */
export async function persistRoot(root: ProjectRoot): Promise<void> {
  if (root.handle === null) return;
  const db = await openDb();
  await put(db, { id: root.id, name: root.name, handle: root.handle });
}

/** Drop a root from persistence; safe to call for session-only roots too. */
export async function removeRoot(id: string): Promise<void> {
  const db = await openDb();
  await del(db, id);
}

/** Manual picker: File System Access API first, `webkitdirectory` fallback. */
export async function pickProjectRoot(): Promise<ProjectRoot | null> {
  if (typeof showDirectoryPicker === "function") {
    const handle = await showDirectoryPicker({ mode: "read" });
    return { id: crypto.randomUUID(), name: handle.name, handle, files: null };
  }
  return pickViaInputFallback();
}

function pickViaInputFallback(): Promise<ProjectRoot | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.style.display = "none";
    document.body.append(input);

    let settled = false;
    let cancelTimer: ReturnType<typeof setTimeout> | null = null;
    const done = (value: ProjectRoot | null): void => {
      if (settled) return;
      settled = true;
      if (cancelTimer !== null) clearTimeout(cancelTimer);
      input.remove();
      resolve(value);
    };

    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      if (files.length === 0) {
        done(null);
        return;
      }
      const name = files[0]?.webkitRelativePath.split("/")[0] ?? "project";
      done({ id: crypto.randomUUID(), name, handle: null, files });
    });
    // The file input has no cancel event; detect the picker closing via focus.
    window.addEventListener(
      "focus",
      () => {
        cancelTimer = setTimeout(() => done(null), 300);
      },
      { once: true },
    );
    input.click();
  });
}

function splitPath(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

async function dirAt(
  handle: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle | null> {
  let dir = handle;
  for (const part of splitPath(path)) {
    try {
      dir = await dir.getDirectoryHandle(part);
    } catch {
      return null;
    }
  }
  return dir;
}

/** Browser DirReader over an FSA directory handle, relative to the root handle. */
export function createHandleDirReader(handle: FileSystemDirectoryHandle): DirReader {
  return {
    async list(path) {
      const dir = await dirAt(handle, path);
      if (dir === null) return [];
      const entries: DirEntry[] = [];
      for await (const [name, child] of dir.entries()) {
        entries.push({ name, isDir: child.kind === "directory" });
      }
      return entries;
    },
    async readText(path) {
      const parts = splitPath(path);
      const fileName = parts.pop();
      if (fileName === undefined) return null;
      const dir = await dirAt(handle, parts.join("/"));
      if (dir === null) return null;
      try {
        const fileHandle = await dir.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        return { text: await file.text(), mtimeMs: file.lastModified };
      } catch {
        return null;
      }
    },
  };
}

/** Browser DirReader over `webkitdirectory` File[] trees. */
export function createFallbackDirReader(files: File[]): DirReader {
  const fileByPath = new Map<string, File>();
  const childrenByDir = new Map<string, Map<string, boolean>>();
  const ensureDir = (path: string): void => {
    if (!childrenByDir.has(path)) childrenByDir.set(path, new Map());
  };
  ensureDir("");

  for (const file of files) {
    const relative = file.webkitRelativePath || file.name;
    const parts = splitPath(relative);
    const fileName = parts.pop();
    if (fileName === undefined) continue;
    let dirPath = "";
    for (const part of parts) {
      childrenByDir.get(dirPath)?.set(part, true);
      dirPath = dirPath === "" ? part : `${dirPath}/${part}`;
      ensureDir(dirPath);
    }
    childrenByDir.get(dirPath)?.set(fileName, false);
    fileByPath.set(relative, file);
  }

  return {
    async list(path) {
      const children = childrenByDir.get(path);
      if (children === undefined) return [];
      return [...children.entries()].map(([name, isDir]) => ({ name, isDir }));
    },
    async readText(path) {
      const file = fileByPath.get(path);
      if (file === undefined) return null;
      return { text: await file.text(), mtimeMs: file.lastModified };
    },
  };
}
