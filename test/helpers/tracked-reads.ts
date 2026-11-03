/**
 * A test that reads a gitignored path passes here and fails in CI: the file exists
 * on the machine that wrote it and in no checkout (#167). This finds those reads.
 */
const ROOTS = ["src", "docs", "test", "quality", "web", "scripts", "templates", "mypi-tasks"];

const PATTERNS = [
  /join\(\s*(?:repoRoot|REPO_ROOT|process\.cwd\(\))\s*,\s*"([^"]+)"/g,
  new RegExp(`readFileSync\\(\\s*"((?:${ROOTS.join("|")})/[^"]*)"`, "g"),
];

/** Every repo-relative path literal a test file reads through a known shape. */
export function repoReads(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern)) if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

/** The reads git does not know about, minus the ones a caller has justified. */
export function untrackedReads(input: {
  sources: { path: string; text: string }[];
  isKnown: (path: string) => boolean;
  allow?: Record<string, string>;
}): { path: string; source: string; why: string }[] {
  const bad: { path: string; source: string; why: string }[] = [];
  for (const { path: file, text } of input.sources) {
    for (const read of repoReads(text)) {
      if (input.allow?.[read] !== undefined) continue;
      if (input.isKnown(read)) continue;
      bad.push({ path: read, source: file, why: "not tracked by git" });
    }
  }
  return bad;
}
