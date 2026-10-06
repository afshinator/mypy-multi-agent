import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the session.yaml path. An explicit path is returned unchanged.
 * Otherwise: `session.yaml` in the directory, then one level of subdirectories.
 * Errors when none or multiple are found so the user is forced to be explicit.
 */
export async function resolveSessionPath(dir: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const candidates: string[] = [];
  if (await isFile(join(dir, "session.yaml"))) candidates.push("session.yaml");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relative = join(entry.name, "session.yaml");
    if (await isFile(join(dir, relative))) candidates.push(relative);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) throw new Error("no session.yaml found in the current directory or its subdirectories");
  throw new Error(`multiple session.yaml found — specify one: ${candidates.join(", ")}`);
}
