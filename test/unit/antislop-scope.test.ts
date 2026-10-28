import { describe, expect, it } from "vitest";
import { globToRegExp, matchGlobs, partitionByScope } from "../../scripts/antislop/scope";

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
