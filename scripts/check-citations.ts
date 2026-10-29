/**
 * Citation-form check for a post-mortem document (#122).
 *
 * Criterion 1 of `templates/post-mortem.yaml` asks each finding to name its
 * artifact by a path under one of the target runs, plus a location. A locator on
 * a bare file name is the defect this finds, because a bare name is ambiguous
 * across the runs and the reviewer rejects it.
 *
 * This is a CONSISTENCY check, not a failure predictor. Measured across the three
 * post-mortem documents on disk: one carried 286 of these and passed every
 * criterion in a single verdict block, while two carried one each and needed 4
 * and 11 blocks. Do not cite it as evidence that a document will pass or fail.
 *
 * Deliberately out of scope: an anchored path that carries no locator. That needs
 * section awareness, because the §1 artifact inventory and the per-analyst "read
 * scope" lists are legitimately locator-free. False positives there would cost
 * the check more than it earns.
 *
 * Usage: bun run check-citations [path]
 *        Default path: run-details/findings-summary.md, relative to the cwd.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export interface BareCitation {
  /** 1-based line in the document. */
  line: number;
  /** The offending token, e.g. `tool-calls.jsonl:16`. */
  token: string;
}

/** A file name with a known artifact extension. The hyphen is load-bearing: without
 * it `run-state.json:1` would also match as `state.json:1`. */
const ARTIFACT = String.raw`[A-Za-z0-9_][A-Za-z0-9_.\-]*\.(?:jsonl|json|ya?ml|md|ts|log|txt)`;

/** The name must not follow a path or word character, so an anchored path is not
 * a match. */
const BARE = new RegExp(String.raw`(?<![\w/.\-])(${ARTIFACT}):(\d+)`, "g");

export function findBareCitations(text: string): BareCitation[] {
  const out: BareCitation[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(BARE))
      out.push({ line: index + 1, token: `${match[1]}:${match[2]}` });
  });
  return out;
}

if (import.meta.main) {
  const target = process.argv[2] ?? "run-details/findings-summary.md";
  const path = resolve(target);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(
      `cannot read ${target} — pass the document path, e.g. bun run check-citations mypi-tasks/<task>/run-details/findings-summary.md`,
    );
    process.exit(2);
  }
  const found = findBareCitations(text);
  const shown = relative(process.cwd(), path) || path;
  if (found.length === 0) {
    console.log(`${shown}: no bare file names with a locator`);
    process.exit(0);
  }
  for (const defect of found) console.log(`${shown}:${defect.line} -> ${defect.token}`);
  console.log(
    `\n${found.length} bare citation(s). Give each a path under the target run, e.g. mypi-tasks/<task>/run-details/<artifact>:<line>.`,
  );
  process.exit(1);
}
