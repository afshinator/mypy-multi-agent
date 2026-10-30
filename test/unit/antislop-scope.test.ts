import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DECLARED_OUTPUT_DIRS,
  globToRegExp,
  IGNORE_GLOBS,
  matchGlobs,
  partitionByScope,
  SKIP_DIRS,
} from "../../scripts/antislop/scope";

describe("scope globs", () => {
  it("matches a directory glob at any depth, including the root", () => {
    expect(matchGlobs("data/fixture.json", ["**/data/**"])).toBe(true);
    expect(matchGlobs("a/b/data/fixture.json", ["**/data/**"])).toBe(true);
    expect(matchGlobs("src/data.ts", ["**/data/**"])).toBe(false);
    expect(matchGlobs("graphify-out/x/y.ts", ["**/graphify-out/**"])).toBe(true);
  });

  it("matches a file glob at any depth", () => {
    expect(matchGlobs("tsconfig.tsbuildinfo", ["**/*.tsbuildinfo"])).toBe(true);
    expect(matchGlobs("web/dist/app.tsbuildinfo", ["**/*.tsbuildinfo"])).toBe(true);
    expect(matchGlobs("src/a.ts", ["**/*.tsbuildinfo"])).toBe(false);
  });

  it("treats a single star as one path segment", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
  });

  it("splits reported paths into in-scope and out-of-scope", () => {
    const { inScope, outOfScope } = partitionByScope(
      ["src/a.ts", "data/f.json", "graphify-out/g.ts", "tests/b.ts"],
      ["**/data/**", "**/graphify-out/**"],
    );
    expect(inScope).toEqual(["src/a.ts", "tests/b.ts"]);
    expect(outOfScope).toEqual(["data/f.json", "graphify-out/g.ts"]);
  });

  it("does not unescape regex metacharacters in a path", () => {
    expect(matchGlobs("src/a+b.ts", ["src/a+b.ts"])).toBe(true);
  });
});

/**
 * The scope lists are the only guard between "the audit measures this repo" and "the audit
 * measures the caches and outputs of this repo's own tooling". They are hand-maintained, so
 * the invariant is asserted rather than remembered: every directory git already treats as
 * ignored must be skipped by name or by glob. Adding a tool that writes `reports2/` and
 * ignoring it in `.gitignore` makes this test fail with the file to edit.
 *
 * `run-details/` is the exception: the collector records it as a declared delta instead of
 * excluding it, so it stays visible in the artifact.
 */
describe("declared scope covers every ignored directory", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  const ignoredDirs = (): string[] => {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return out
      .split("\n")
      .filter((line) => line.endsWith("/"))
      .map((line) => line.slice(0, -1));
  };

  const basename = (path: string): string => path.split("/").pop() ?? path;

  const uncovered = (dirs: string[]): string[] =>
    dirs.filter(
      (dir) =>
        !SKIP_DIRS.has(basename(dir)) &&
        !matchGlobs(`${dir}/`, IGNORE_GLOBS) &&
        !DECLARED_OUTPUT_DIRS.has(basename(dir)),
    );

  it("finds ignored directories to check, so an empty list cannot pass silently", () => {
    // `node_modules/` is present whenever the suite can run at all.
    expect(ignoredDirs().length).toBeGreaterThan(0);
  });

  it("skips every ignored directory in the checkout, or declares it as output", () => {
    expect(uncovered(ignoredDirs())).toEqual([]);
  });

  it("reports a new ignored directory as uncovered", () => {
    expect(
      uncovered(["reports2", "some-cache/probe", "reports", ".fallow", "run-details"]),
    ).toEqual(["reports2", "some-cache/probe"]);
  });
});
