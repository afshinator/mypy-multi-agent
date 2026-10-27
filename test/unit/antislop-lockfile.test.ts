import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageFromAdvisory, resolveInstalled, stripJsonc } from "../../scripts/antislop/lockfile";

const dirs: string[] = [];
const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "antislop-lock-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, rel), content);
  return root;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("lockfile resolution", () => {
  it("strips trailing commas and comments without touching URLs inside strings", () => {
    const jsonc = `{
      // a comment
      "url": "https://registry.example/x", /* inline */
      "packages": { "a": ["a@1.2.3", "", {}, "sha"], },
    }`;
    const parsed = JSON.parse(stripJsonc(jsonc)) as {
      url: string;
      packages: Record<string, string[]>;
    };
    expect(parsed.url).toBe("https://registry.example/x");
    expect(parsed.packages.a?.[0]).toBe("a@1.2.3");
  });

  it("resolves from bun.lock, including a scoped package", () => {
    const root = repo({
      "bun.lock":
        '{ "packages": { "undici": ["undici@8.10.2", "", {}], "@scope/pkg": ["@scope/pkg@0.4.1", "", {}], }, }',
    });
    expect(resolveInstalled(root, "undici")).toEqual({
      package: "undici",
      version: "8.10.2",
      source: "bun.lock",
    });
    expect(resolveInstalled(root, "@scope/pkg")?.version).toBe("0.4.1");
  });

  it("resolves from package-lock v3 and prefers the shallowest duplicate", () => {
    const root = repo({
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "x" },
          "node_modules/react": { version: "19.2.3" },
          "node_modules/a/node_modules/react": { version: "18.0.0" },
        },
      }),
    });
    expect(resolveInstalled(root, "react")).toEqual({
      package: "react",
      version: "19.2.3",
      source: "package-lock.json",
    });
  });

  it("falls back to a v1 dependencies map", () => {
    const root = repo({
      "package-lock.json": JSON.stringify({
        lockfileVersion: 1,
        dependencies: { lodash: { version: "4.17.21" } },
      }),
    });
    expect(resolveInstalled(root, "lodash")?.version).toBe("4.17.21");
  });

  it("returns null rather than guessing for pnpm, yarn or an absent lockfile", () => {
    expect(
      resolveInstalled(repo({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }), "x"),
    ).toBeNull();
    expect(resolveInstalled(repo({ "yarn.lock": 'x@^1:\n  version "1.0.0"\n' }), "x")).toBeNull();
    expect(resolveInstalled(repo({}), "x")).toBeNull();
  });

  it("reads the package name aislop puts in front of an advisory", () => {
    expect(packageFromAdvisory("undici (high) — undici vulnerable to DoS")).toBe("undici");
    expect(packageFromAdvisory("@scope/pkg (high) — x")).toBe("@scope/pkg");
    expect(packageFromAdvisory("no package named here")).toBeNull();
  });
});
