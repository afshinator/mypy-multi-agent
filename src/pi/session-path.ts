/**
 * Resolves which session.yaml to run. Search order when no path is given:
 * `session.yaml` in the directory, then tasks under `.mypi/<task>/`, then one
 * level of subdirectories. Fails when none or several match. An explicit bare
 * name resolves to `.mypi/<name>/session.yaml`.
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

/** Existing `.mypi/<task>/session.yaml` paths, sorted for deterministic errors. */
async function mpyiTasks(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, ".mypi"), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relative = join(".mypi", entry.name, "session.yaml");
    if (await isFile(join(dir, relative))) found.push(relative);
  }
  return found.sort();
}

/**
 * Resolve the session.yaml path.
 * - An explicit file path is returned unchanged.
 * - An explicit directory resolves to `<dir>/session.yaml`.
 * - An explicit bare name resolves to `.mypi/<name>/session.yaml`.
 * - No path: `<dir>/session.yaml`, then tasks under `.mypi/`, then one level
 *   of subdirectories. Errors when none or several are found.
 */
export async function resolveSessionPath(dir: string, explicit?: string): Promise<string> {
  if (explicit) {
    const abs = resolve(dir, explicit);
    if (await isFile(abs)) return explicit;
    const nested = join(explicit, "session.yaml");
    if (await isFile(join(abs, "session.yaml"))) return nested;
    const named = join(".mypi", explicit, "session.yaml");
    if (await isFile(join(dir, named))) return named;
    throw new Error(`no session.yaml at "${explicit}", "${nested}", or "${named}"`);
  }
  const candidates: string[] = [];
  if (await isFile(join(dir, "session.yaml"))) candidates.push("session.yaml");
  candidates.push(...(await mpyiTasks(dir)));
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".mypi" || entry.name === "node_modules") continue;
    const relative = join(entry.name, "session.yaml");
    if (await isFile(join(dir, relative))) candidates.push(relative);
  }
  if (candidates.length > 1)
    throw new Error(`multiple session.yaml found — specify one: ${candidates.join(", ")}`);
  const [resolved] = candidates;
  if (!resolved)
    throw new Error("no session.yaml found in the current directory, .mypi/, or one level down");
  return resolved;
}
