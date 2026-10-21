/**
 * Browser-only project-root access: File System Access API picker and IndexedDB
 * persistence (`run-inspector` / `projects`). Requires a Chromium-based browser
 * for the File System Access API. Nothing here is imported by tests.
 */
import type { DirEntry, DirReader } from "../lib/reader";

export type ProjectRoot =
  | { id: string; name: string; source: "fsa"; handle: FileSystemDirectoryHandle }
  | { id: string; name: string; source: "server" };

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
    roots.push({ id: record.id, name: record.name, source: "fsa", handle: record.handle });
  }
  return roots;
}

/** Persist a root so it auto-restores next launch. */
export async function persistRoot(root: ProjectRoot): Promise<void> {
  if (root.source !== "fsa") return;
  const db = await openDb();
  await put(db, { id: root.id, name: root.name, handle: root.handle });
}

/** Drop a root from persistence. */
export async function removeRoot(id: string): Promise<void> {
  const db = await openDb();
  await del(db, id);
}

/**
 * Open the directory picker (File System Access API). Returns null when the
 * user cancels; throws when the API is unavailable (non-Chromium browser).
 */
export async function pickProjectRoot(): Promise<ProjectRoot | null> {
  if (typeof showDirectoryPicker !== "function") {
    throw new Error(
      "The File System Access API is unavailable in this browser — it may be disabled by privacy settings (e.g. Brave Shields fingerprinting protection).",
    );
  }
  try {
    const handle = await showDirectoryPicker({ mode: "read" });
    return { id: crypto.randomUUID(), name: handle.name, source: "fsa", handle };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
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
