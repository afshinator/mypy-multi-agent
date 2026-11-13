/**
 * cite-check: resolve a document's file:line citations against the working tree (#568).
 *
 * Documents here prove claims with `path:NN` and `path:NN-MM` citations, and the lines
 * move: biome reformats, edits shift ranges, and a ticket that names the wrong line is
 * worse than one that names none. This command resolves each citation and reports the
 * failures — a missing file, or a line past the file's end — with the citation's own
 * line number, so the fix is one `read` away.
 *
 * Usage: bun scripts/cite-check.ts <file.md>
 *        Exit 0 when every citation resolves, non-zero otherwise.
 *
 * Distinct from scripts/check-citations.ts (#122), which flags *bare* file names with a
 * locator in post-mortem docs; this one resolves *anchored* paths against the tree.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface Citation {
  /** 1-based line of the citation in the document. */
  line: number;
  /** The cited path exactly as written. */
  path: string;
  /** 1-based start line. */
  start: number;
  /** 1-based end line, when a range was given. */
  end?: number;
}

export interface Failure {
  /** 1-based line of the citation in the document. */
  line: number;
  /** Human-readable reason, naming the citation and what did not resolve. */
  reason: string;
}

/** A path ending in a known artifact extension, then `:NN` or `:NN-MM`. `@` covers
 * scoped package paths (`@scope/name/dist/...`), which appear in absolute citations. */
const PATTERN = /([A-Za-z0-9_./~@-]+\.(?:ts|tsx|js|md|ya?ml|json|jsonl|txt|log)):(\d+)(?:-(\d+))?/g;

export function findCitations(text: string): Citation[] {
  const out: Citation[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(PATTERN)) {
      const path = m[1];
      const start = m[2];
      if (path === undefined || start === undefined) continue;
      out.push({
        line: i + 1,
        path,
        start: Number(start),
        ...(m[3] === undefined ? {} : { end: Number(m[3]) }),
      });
    }
  });
  return out;
}

/** The number of lines a file has, the way `wc -l` counts them. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}

/** Resolve a citation's path against the tree: `~` to the home dir, absolute as-is. */
export function resolveCitationPath(path: string, cwd: string, home: string): string {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path.startsWith("~")) return join(home, path.slice(1));
  if (isAbsolute(path)) return path;
  return resolve(cwd, path);
}

export function checkCitations(text: string, cwd: string, home: string = homedir()): Failure[] {
  const failures: Failure[] = [];
  for (const c of findCitations(text)) {
    const abs = resolveCitationPath(c.path, cwd, home);
    if (!existsSync(abs)) {
      failures.push({ line: c.line, reason: `${c.path}:${c.start} — file not found: ${abs}` });
      continue;
    }
    const count = lineCount(readFileSync(abs, "utf8"));
    const end = c.end ?? c.start;
    if (end > count) {
      failures.push({
        line: c.line,
        reason: `${c.path}:${c.start}${c.end === undefined ? "" : `-${c.end}`} — line ${end} past end of file (${count} lines)`,
      });
    }
  }
  return failures;
}

if (import.meta.main) {
  const target = process.argv[2];
  if (target === undefined) {
    console.error("usage: bun scripts/cite-check.ts <file.md>");
    process.exit(2);
  }
  const cwd = process.cwd();
  let text: string;
  try {
    text = readFileSync(resolve(cwd, target), "utf8");
  } catch {
    console.error(`cannot read ${target}`);
    process.exit(2);
  }
  const failures = checkCitations(text, cwd);
  if (failures.length === 0) {
    console.log(`${target}: all citations resolve`);
    process.exit(0);
  }
  for (const f of failures) console.log(`${target}:${f.line}: ${f.reason}`);
  console.log(`\n${failures.length} unresolved citation(s).`);
  process.exit(1);
}
