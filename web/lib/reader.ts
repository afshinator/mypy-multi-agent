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
