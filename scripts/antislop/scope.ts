/**
 * Declared scope: which paths count as the code under audit.
 *
 * A repo can track generated and fixture trees (data/, graphify-out/, agent config
 * directories), and they are not app source. Tools that take globs get them at
 * invocation; tools that cannot (biome resolves ignores from config and .gitignore only)
 * keep reporting there, so the sample is drawn from in-scope paths and everything else is
 * marked rather than deleted — the artifact still shows what the tool claimed.
 */

/**
 * Directory names the file walk never enters, and the file glob form of the same decision
 * for analyzers that take globs. Both are declared scope, so they live here rather than in
 * the collector: `test/unit/antislop-scope.test.ts` asserts that every git-ignored
 * directory in the checkout is covered by one of these, which is what keeps this list from
 * going stale as tooling adds output trees.
 */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  // Generated or vendored, never source: a Python venv would otherwise inflate the
  // language surface by an order of magnitude and a .next build can hold thousands of files.
  ".venv",
  "venv",
  ".next",
  ".turbo",
  ".svelte-kit",
  // Written by this repo's own tooling, and a copy of the tree rather than the tree:
  // a leaked Stryker sandbox made bandit report 42 findings from vendored duplicates.
  ".stryker-tmp",
  ".fallow",
  ".ruff_cache",
  "reports",
]);

/**
 * Analyzer ignore configuration, passed at invocation rather than baked into the manifest
 * so the pinned toolchain stays the record of what was provisioned.
 *
 * The pilot ran without these and paid for it: jscpd scanned a Next build directory and
 * 379 findings came from one generated folder. An analyzer that reports outside the
 * declared scope is not measuring the repo.
 */
export const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/.venv/**",
  "**/venv/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.turbo/**",
  "**/.stryker-tmp/**",
  "**/.fallow/**",
  "**/.ruff_cache/**",
  "**/reports/**",
  "**/*.tsbuildinfo",
];

/**
 * Ignored directories that are recorded output rather than excluded scope: a task's
 * `run-details/` is named in the collector's declared deltas, so it stays visible in the
 * artifact instead of disappearing from it.
 */
export const DECLARED_OUTPUT_DIRS = new Set(["run-details"]);

/** Glob to RegExp: supports `**`, `*` and `?`, which is all the ignore lists need. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] ?? "";
    if (ch === "*" && glob[i + 1] === "*") {
      // `**/` spans zero or more directories; a trailing `**` matches the rest.
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchGlobs(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * Split reported paths by whether the declared scope covers them. A path that appears
 * here matched a glob and was reported anyway, which means that tool cannot be told to
 * skip it from the command line — biome is the case that matters.
 */
export function partitionByScope(
  paths: string[],
  globs: string[],
): { outOfScope: string[]; inScope: string[] } {
  const outOfScope: string[] = [];
  const inScope: string[] = [];
  for (const path of paths) {
    if (matchGlobs(path, globs)) outOfScope.push(path);
    else inScope.push(path);
  }
  return { outOfScope, inScope };
}
