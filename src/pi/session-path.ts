/**
 * Resolves which session.yaml to run: explicit path, cwd, or one level of
 * subdirectories, failing when none or several match.
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the session.yaml path.
 * - An explicit file path is returned unchanged.
 * - An explicit directory resolves to `<dir>/session.yaml`.
 * - No path: `session.yaml` in the directory, then one level of subdirectories.
 * Errors when none or multiple are found so the user is forced to be explicit.
 */
export async function resolveSessionPath(dir: string, explicit?: string): Promise<string> {
  if (explicit) {
    const abs = resolve(dir, explicit);
    if (await isFile(abs)) return explicit;
    const nested = join(explicit, "session.yaml");
    if (await isFile(join(abs, "session.yaml"))) return nested;
    throw new Error(`no session.yaml at "${explicit}" or "${nested}"`);
  }
  const candidates: string[] = [];
  if (await isFile(join(dir, "session.yaml"))) candidates.push("session.yaml");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relative = join(entry.name, "session.yaml");
    if (await isFile(join(dir, relative))) candidates.push(relative);
  }
  if (candidates.length > 1)
    throw new Error(`multiple session.yaml found — specify one: ${candidates.join(", ")}`);
  const [resolved] = candidates;
  if (!resolved)
    throw new Error("no session.yaml found in the current directory or its subdirectories");
  return resolved;
}
