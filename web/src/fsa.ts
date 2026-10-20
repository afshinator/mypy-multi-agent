import type { DirEntry, DirReader, FileText } from "../lib/discovery";

// File System Access API + IndexedDB persistence for picked project roots.
// shortcut: Chromium-only glue, no unit test; discovery/sorting is tested over
// the pure DirReader seam instead. Upgrade to a shared helper if another view
// needs its own directory walking.

export interface ProjectRoot {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
}

interface StoredProject {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
}

const DB_NAME = "run-inspector";
const STORE = "projects";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putStored(root: StoredProject): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(root);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllStored(): Promise<StoredProject[]> {
  const db = await openDb();
  return new Promise<StoredProject[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as StoredProject[]);
    req.onerror = () => reject(req.error);
  });
}

async function queryRead(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  try {
    return await handle.queryPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

export async function pickProject(): Promise<ProjectRoot | null> {
  const handle = await showDirectoryPicker({ mode: "read" });
  const root: ProjectRoot = { id: crypto.randomUUID(), name: handle.name, handle };
  await putStored(root);
  return root;
}

/** Auto-restore already-granted handles without prompting; prompt/denied stay pending. */
export async function loadProjects(): Promise<ProjectRoot[]> {
  const rows = await getAllStored();
  const granted: ProjectRoot[] = [];
  for (const row of rows) {
    if ((await queryRead(row.handle)) === "granted") granted.push(row);
  }
  return granted;
}

/** Re-grant pending persisted handles; must be called from a user gesture. */
export async function requestRestore(): Promise<ProjectRoot[]> {
  const rows = await getAllStored();
  const granted: ProjectRoot[] = [];
  for (const row of rows) {
    const current = await queryRead(row.handle);
    if (current === "granted") {
      granted.push(row);
      continue;
    }
    if (current === "prompt") {
      try {
        if ((await row.handle.requestPermission({ mode: "read" })) === "granted") {
          granted.push(row);
        }
      } catch {
        // NotAllowedError when the click/gesture context is missing.
      }
    }
  }
  return granted;
}

/** Bridges one picked directory handle to the pure discovery DirReader. */
export class FsaDirReader implements DirReader {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  private async resolveDir(path: string): Promise<FileSystemDirectoryHandle | null> {
    let dir = this.root;
    if (path === "") return dir;
    for (const seg of path.split("/")) {
      try {
        dir = await dir.getDirectoryHandle(seg);
      } catch {
        return null;
      }
    }
    return dir;
  }

  async list(path: string): Promise<DirEntry[]> {
    const dir = await this.resolveDir(path);
    if (dir === null) return [];
    const out: DirEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
      out.push({ name, isDir: handle.kind === "directory" });
    }
    return out;
  }

  async readText(path: string): Promise<FileText | null> {
    const segments = path.split("/");
    const fileName = segments.pop();
    if (fileName === undefined) return null;
    const dir = await this.resolveDir(segments.join("/"));
    if (dir === null) return null;
    try {
      const file = await (await dir.getFileHandle(fileName)).getFile();
      return { text: await file.text(), mtimeMs: file.lastModified };
    } catch {
      return null;
    }
  }
}
