export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface FileText {
  text: string;
  mtimeMs?: number;
}

/**
 * Minimal directory surface the run loaders read through, so the read path
 * stays pure and testable in-memory. The browser FSA reader and any dummy
 * reader both implement it.
 */
export interface DirReader {
  list(path: string): Promise<DirEntry[]>;
  readText(path: string): Promise<FileText | null>;
}

/** Directory reader backed by the local read-only development server API. */
export class HttpDirReader implements DirReader {
  async list(path: string): Promise<DirEntry[]> {
    try {
      const response = await fetch(`/api/fs/list?${new URLSearchParams({ path })}`);
      if (!response.ok) return [];
      const entries: unknown = await response.json();
      return Array.isArray(entries)
        ? entries.filter(
            (entry): entry is DirEntry =>
              typeof entry === "object" &&
              entry !== null &&
              "name" in entry &&
              typeof entry.name === "string" &&
              "isDir" in entry &&
              typeof entry.isDir === "boolean",
          )
        : [];
    } catch {
      return [];
    }
  }

  async readText(path: string): Promise<FileText | null> {
    try {
      const response = await fetch(`/api/fs/read?${new URLSearchParams({ path })}`);
      if (!response.ok) return null;
      const result: unknown = await response.json();
      if (
        typeof result !== "object" ||
        result === null ||
        !("text" in result) ||
        typeof result.text !== "string"
      ) {
        return null;
      }
      return {
        text: result.text,
        ...("mtimeMs" in result && typeof result.mtimeMs === "number"
          ? { mtimeMs: result.mtimeMs }
          : {}),
      };
    } catch {
      return null;
    }
  }
}
