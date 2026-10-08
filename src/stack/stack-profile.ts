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

/** Suggested analyzers; availability is confirmed at run time, not assumed here. */
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
