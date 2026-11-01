/**
 * Batch model preflight: can every slug in a manifest actually be opened?
 *
 * The runtime resolves a slug with `registry.find(provider, model)`
 * (src/pi/model-preflight.ts), i.e. exactly. `pi --list-models <slug>` is a
 * *search*: it exits 0 with no matches, and a fuzzy slug returns neighbouring
 * rows. So exit status proves nothing and a near-miss row is not a match — this
 * module accepts only a row whose provider and model columns both equal the
 * slug's parts.
 */
import { execFile } from "node:child_process";

export type Exec = (args: string[]) => Promise<string>;

export interface ModelResolution {
  slug: string;
  ok: boolean;
  /** Rows that matched provider and model exactly; 0 unless ok. */
  matches: number;
  reason?: "unknown-model" | "cli-failed";
}

const defaultExec: Exec = (args) =>
  new Promise((resolve, reject) => {
    execFile("pi", args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** Data rows of the table; the header and the no-match notice are not rows. */
function rows(stdout: string): { provider: string; model: string }[] {
  if (stdout.trimStart().startsWith("No models matching")) return [];
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.trim().split(/\s+/))
    .filter((cells) => cells.length >= 2 && cells[0] !== "provider")
    .map(([provider = "", model = ""]) => ({ provider, model }));
}

/**
 * One result per distinct slug, in first-seen order. A slug without a provider
 * is unknown without a call; a CLI that fails is `cli-failed`, never ok.
 */
export async function resolveModels(
  slugs: readonly string[],
  exec: Exec = defaultExec,
): Promise<ModelResolution[]> {
  const out: ModelResolution[] = [];
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);

    const i = slug.indexOf("/");
    if (i <= 0 || i === slug.length - 1) {
      out.push({ slug, ok: false, matches: 0, reason: "unknown-model" });
      continue;
    }
    const provider = slug.slice(0, i);
    const model = slug.slice(i + 1);

    let stdout: string;
    try {
      stdout = await exec(["--list-models", slug]);
    } catch {
      out.push({ slug, ok: false, matches: 0, reason: "cli-failed" });
      continue;
    }
    const matches = rows(stdout).filter((r) => r.provider === provider && r.model === model).length;
    out.push(
      matches > 0
        ? { slug, ok: true, matches }
        : { slug, ok: false, matches: 0, reason: "unknown-model" },
    );
  }
  return out;
}
