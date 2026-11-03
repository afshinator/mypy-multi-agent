import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoReads, untrackedReads } from "../helpers/tracked-reads";

const repoRoot = process.cwd();

/**
 * Paths read on purpose that a checkout does not contain. Each entry is a reason the
 * guard cannot infer, and the rot check below fails if one becomes tracked.
 */
const ALLOW: Record<string, string> = {
  // Local only. Read behind existsSync, so a checkout simply skips it.
  "quality/ledger.jsonl": "local-only ledger, read only when present",
  // Frozen run artifacts are gitignored (`.gitignore:6`), so this comparison only runs
  // on a machine that has the run. CI skips it, which the guard now makes visible.
  "mypi-tasks/05-interpretation/run-details": "gitignored run artifacts, read only when present",
};

function testSources(dir = join(repoRoot, "test")): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testSources(full));
    else if (entry.endsWith(".ts")) {
      out.push({ path: full.slice(repoRoot.length + 1), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

/** A file or a directory: tests read both, and `--error-unmatch` only answers for files. */
function tracked(path: string): boolean {
  try {
    return (
      execFileSync("git", ["ls-files", "--error-unmatch", path], { cwd: repoRoot, stdio: "pipe" })
        .toString()
        .trim() !== ""
    );
  } catch {
    return (
      execFileSync("git", ["ls-files", path], { cwd: repoRoot, stdio: "pipe" })
        .toString()
        .trim() !== ""
    );
  }
}

describe("repoReads", () => {
  it("finds both shapes a test resolves the repo root with", () => {
    // Built by concatenation so this file's own scan of `test/` does not match.
    const source = [
      `const a = readFileSync(join(repoRoot, ${'"src/pi/launch.ts"'}), "utf8");`,
      `const b = readFileSync(join(process.cwd(), ${'"docs/batch-guide.md"'}), "utf8");`,
      `const c = readFileSync(${'"templates/batch-code-fix.yaml"'}, "utf8");`,
    ].join("\n");
    expect(repoReads(source)).toEqual([
      "docs/batch-guide.md",
      "src/pi/launch.ts",
      "templates/batch-code-fix.yaml",
    ]);
  });

  it("reports a gitignored path and passes a tracked one", () => {
    const local = `readFileSync(join(repoRoot, ${'"quality/ledger.jsonl"'}), "utf8")`;
    const trackedFile = `readFileSync(join(repoRoot, ${'"package.json"'}), "utf8")`;

    expect(
      untrackedReads({
        sources: [{ path: "test/unit/x.test.ts", text: local }],
        isKnown: (p) => tracked(p),
      }),
    ).toEqual([
      { path: "quality/ledger.jsonl", source: "test/unit/x.test.ts", why: "not tracked by git" },
    ]);
    expect(
      untrackedReads({
        sources: [{ path: "test/unit/x.test.ts", text: trackedFile }],
        isKnown: (p) => tracked(p),
      }),
    ).toEqual([]);
  });

  it("keeps a justified path out of the report", () => {
    const local = `readFileSync(join(repoRoot, ${'"quality/ledger.jsonl"'}), "utf8")`;
    expect(
      untrackedReads({
        sources: [{ path: "test/unit/x.test.ts", text: local }],
        isKnown: () => false,
        allow: { "quality/ledger.jsonl": "local only" },
      }),
    ).toEqual([]);
  });
});

describe("the suite reads nothing a checkout does not have", () => {
  it("reports no untracked repo-relative read", () => {
    expect(
      untrackedReads({
        sources: testSources(),
        isKnown: (p) => tracked(p),
        allow: ALLOW,
      }),
    ).toEqual([]);
  });

  it("goes red on a file that reads a gitignored path, and green once it is gone", () => {
    // Concatenated so this file does not report itself, and pointed at the gitignored
    // `run-details/` rule rather than at an allowlisted path the scan would skip.
    const probe = join(repoRoot, "test/unit/" + ".tracked-reads-probe.ts");
    const read = [
      "readFileSync(join(repo",
      'Root, "mypi-tasks/05-probe/run-details/x.json"), "utf8");',
    ].join("");
    const scan = () =>
      untrackedReads({ sources: testSources(), isKnown: (p) => tracked(p), allow: ALLOW }).filter(
        (r) => r.source === "test/unit/.tracked-reads-probe.ts",
      );
    try {
      writeFileSync(probe, `${read}\n`);
      expect(scan()).toHaveLength(1);
    } finally {
      rmSync(probe, { force: true });
    }
    expect(scan()).toEqual([]);
  });

  it("allows only paths that are genuinely untracked, so the list cannot rot", () => {
    for (const path of Object.keys(ALLOW)) expect(tracked(path)).toBe(false);
  });
});
