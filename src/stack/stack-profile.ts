/**
 * Stack detection (portability seam B/E): probe a repository for its language
 * and the commands that mean "test/build/lint" there, so a run is not hardwired
 * to JS/TS + just. Pure filesystem reads — nothing is executed. Consumed by the
 * session scaffolder and the launch briefing.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Language family used to pick a default validation command set + analyzers. */
export type Language = "js-ts" | "python" | "rust" | "go" | "unknown";

export interface StackProfile {
  language: Language;
  /** Marker files found in the probed directory. */
  markers: string[];
  /** Commands that constitute a green run; empty when nothing standard applies. */
  validation: string[];
  /** Suggested analyzer ids for this language (see `ANALYZER_CATALOG`). */
  analyzers: string[];
}

export interface AnalyzerInfo {
  id: string;
  /** What it finds, for the briefing line. */
  kind: string;
  /** Suggested invocation; the supervisor confirms the tool is installed first. */
  command: string;
}

/**
 * Suggested analyzers; availability is confirmed at run time, not assumed here.
 *
 * Why these ids (survey 2026-10-07; work orders in `docs/TODO.md` "Next"):
 * - semgrep — primary generic analyzer: AST structural search + security/pattern
 *   rules, polyglot; CLI `--json` or MCP.
 * - fallow — JS/TS baseline: dead code, unreachable exports, unused deps,
 *   circular imports, clones, complexity.
 * - knip — monorepo-aware unused files/deps/exports; complements fallow.
 * - jscpd — copy/paste duplication with coordinates + similarity.
 * - biome — lint + format + import sort, near-zero config, JSON diagnostics;
 *   default for agent workflows and new repos. ESLint v9 (flat config) is the
 *   alternative for existing enterprise repos with plugins, and Oxlint (fast
 *   correctness checks) runs alongside it; neither is in the catalog.
 * - ruff — fast Python lint + format (the Python Biome analogue).
 * - mypy (or pyright) — Python type checking; pytest is the runner, already
 *   emitted as Python validation by `detectStack`.
 * - Deferred, so not in the catalog: GritQL (polyglot AST transforms / slop
 *   removal; CLI JSON), Trivy (secrets/CVE/IaC; CLI JSON), SonarQube
 *   (`sonar-scanner`; cognitive complexity + duplication; SARIF/JSON; heavy,
 *   only where already in use).
 *
 * Per-stack recommendation:
 * | stack  | analyze          | dead code / deps | lint + format     | tests        |
 * | JS/TS  | fallow + semgrep | fallow + knip    | biome / eslint v9 | package.json |
 * | Python | semgrep + ruff   | semgrep          | ruff              | pytest       |
 * | other  | semgrep (+sonar) | semgrep          | repo's own        | repo's own   |
 */
export const ANALYZER_CATALOG: readonly AnalyzerInfo[] = [
  {
    id: "fallow",
    kind: "dead code + complexity",
    command: "fallow health; fallow dead-code --format json --quiet",
  },
  { id: "biome", kind: "lint + format", command: "biome check ." },
  { id: "knip", kind: "unused files/deps/exports", command: "knip --reporter json" },
  { id: "jscpd", kind: "duplication", command: "jscpd --reporters json ." },
  { id: "ruff", kind: "lint + format", command: "ruff check --output-format json ." },
  { id: "semgrep", kind: "patterns + security", command: "semgrep --json" },
];

/** Render suggested analyzers as briefing lines; unknown ids are skipped. */
export function describeAnalyzers(ids: readonly string[]): string[] {
  return ids
    .map((id) => ANALYZER_CATALOG.find((a) => a.id === id))
    .filter((a): a is AnalyzerInfo => a !== undefined)
    .map((a) => `${a.id} (${a.kind}) — ${a.command}`);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Validation from package.json scripts, in gate order, only when the script exists. */
async function jsValidation(dir: string): Promise<string[]> {
  const raw = await readText(join(dir, "package.json"));
  if (raw === null) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(raw).scripts ?? {}) as Record<string, unknown>;
  } catch {
    return [];
  }
  const bun = (await isFile(join(dir, "bun.lock"))) || (await isFile(join(dir, "bun.lockb")));
  const runner = bun ? "bun" : "npm";
  return ["test", "typecheck", "lint", "check"]
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => `${runner} run ${name}`);
}

/**
 * Probe `dir` for a language marker and its default validation commands.
 * Precedence: package.json → Python markers → Cargo.toml → go.mod →
 * Makefile → justfile. First match wins; later markers are still recorded.
 */
export async function detectStack(dir: string): Promise<StackProfile> {
  const markers: string[] = [];
  const has = async (name: string): Promise<boolean> => {
    if (await isFile(join(dir, name))) {
      markers.push(name);
      return true;
    }
    return false;
  };

  if (await has("package.json")) {
    return {
      language: "js-ts",
      markers,
      validation: await jsValidation(dir),
      analyzers: ["fallow", "biome"],
    };
  }
  if ((await has("pyproject.toml")) || (await has("requirements.txt")) || (await has("setup.py"))) {
    return {
      language: "python",
      markers,
      validation: ["ruff check .", "pytest"],
      analyzers: ["ruff"],
    };
  }
  if (await has("Cargo.toml")) {
    return { language: "rust", markers, validation: ["cargo test"], analyzers: [] };
  }
  if (await has("go.mod")) {
    return { language: "go", markers, validation: ["go test ./..."], analyzers: [] };
  }
  if (await has("Makefile")) {
    return { language: "unknown", markers, validation: ["make test"], analyzers: [] };
  }
  if (await has("justfile")) {
    return { language: "unknown", markers, validation: ["just test"], analyzers: [] };
  }
  return { language: "unknown", markers, validation: [], analyzers: [] };
}
