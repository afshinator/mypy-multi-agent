import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectEnvironment } from "../../scripts/antislop/environment";
import { reportedFileCount } from "../../scripts/antislop/normalize";

const dirs: string[] = [];

/** A repo shaped like the pilot: bun, declared knip entries, no venv. */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "antislop-env-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const detect = (root: string, skip: string[] = ["node_modules", ".git"]) =>
  detectEnvironment(root, { skipDirs: new Set(skip) });

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("environment detection", () => {
  it("reads the package manager from the lockfile", () => {
    expect(detect(repo({ "package.json": "{}", "bun.lock": "" })).package_manager).toBe("bun");
    expect(detect(repo({ "package.json": "{}", "package-lock.json": "{}" })).package_manager).toBe(
      "npm",
    );
  });

  it("records workspaces as declared only when something declares them", () => {
    const none = detect(repo({ "package.json": '{"name":"x"}' }));
    expect(none.workspaces).toEqual({ declared: false, source: null });
    const pnpm = detect(
      repo({ "package.json": "{}", "pnpm-workspace.yaml": "packages:\n  - web\n" }),
    );
    expect(pnpm.workspaces).toEqual({ declared: true, source: "pnpm-workspace.yaml" });
  });

  it("records declared entry points and existing linters", () => {
    const env = detect(
      repo({
        "package.json": '{"bin":{"task":"cli.js"}}',
        "knip.json": "{}",
        "biome.json": "{}",
        "tsconfig.json": '{"include":["src"],"exclude":["scripts"]}',
      }),
    );
    expect(env.entry_declarations.knip_config).toBe("knip.json");
    expect(env.entry_declarations.package_bin).toEqual(["task"]);
    expect(env.entry_declarations.tsconfig_include).toEqual(["src"]);
    expect(env.linters_present).toEqual(["biome.json"]);
  });

  it("counts the language surface per extension and skips the excluded dirs", () => {
    const env = detect(
      repo({
        "src/a.ts": "const a = 1;\nconst b = 2;\n",
        "src/py/main.py": "print(1)\n",
        ".venv/lib/x.py": "print(2)\n",
        "README.md": "# hi\n",
      }),
      ["node_modules", ".venv"],
    );
    expect(env.language_surface).toEqual([
      { ext: ".ts", files: 1, loc: 2 },
      { ext: ".py", files: 1, loc: 1 },
    ]);
    // present on disk but excluded: reported as an exclusion, not as code
    expect(env.excluded_present).toContain(".venv");
  });
});

describe("exclusions are visible where they happen", () => {
  it("reports a nested venv by its relative path, not just root-level directories", () => {
    // finance-hub keeps its venv at telegram-forwarder/.venv: a root-level check misses it
    const env = detect(
      repo({
        "telegram-forwarder/main.py": "print(1)\n",
        "telegram-forwarder/.venv/lib/x.py": "print(2)\n",
        ".next/static/y.js": "x\n",
      }),
      ["node_modules", ".git", ".venv", ".next"],
    );
    expect(env.excluded_present).toEqual([".next", "telegram-forwarder/.venv"]);
    expect(env.language_surface).toEqual([{ ext: ".py", files: 1, loc: 1 }]);
  });
});

describe("a tool's own scanned-file count", () => {
  it("reads the count each reporter actually prints", () => {
    expect(reportedFileCount("oxlint", '{"number_of_files":239}')).toEqual({
      reported: 239,
      source: "number_of_files",
    });
    expect(reportedFileCount("aislop", '{"coverage":{"supportedFiles":240}}').reported).toBe(240);
    expect(reportedFileCount("jscpd", '{"statistics":{"total":{"sources":170}}}').reported).toBe(
      170,
    );
    expect(reportedFileCount("biome", '{"summary":{"changed":0,"unchanged":259}}')).toEqual({
      reported: 259,
      source: "summary.changed+unchanged",
    });
  });

  it("returns null rather than guessing for tools that report no coverage", () => {
    expect(reportedFileCount("knip", '{"issues":[]}')).toEqual({ reported: null, source: null });
    expect(reportedFileCount("fallow", "not json")).toEqual({ reported: null, source: null });
  });
});
