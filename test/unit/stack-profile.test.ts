/**
 * Unit tests for stack detection: a repo's language and the commands that mean
 * "green" there, so a run is not hardwired to JS/TS + just.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYZER_CATALOG, describeAnalyzers, detectStack } from "../../src/stack/stack-profile";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stack-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

describe("detectStack", () => {
  it("returns unknown/empty for a repo with no markers", async () => {
    const dir = await repo({ "README.md": "hi" });
    try {
      const p = await detectStack(dir);
      expect(p.language).toBe("unknown");
      expect(p.markers).toEqual([]);
      expect(p.validation).toEqual([]);
      expect(p.analyzers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects JS/TS and derives validation from package.json scripts", async () => {
    const dir = await repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc" } }),
      "bun.lock": "",
    });
    try {
      const p = await detectStack(dir);
      expect(p.language).toBe("js-ts");
      expect(p.markers).toContain("package.json");
      expect(p.validation).toEqual(["bun run test", "bun run typecheck"]);
      expect(p.analyzers).toEqual(["fallow", "biome"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses npm when no bun lockfile is present", async () => {
    const dir = await repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
    try {
      const p = await detectStack(dir);
      expect(p.validation).toEqual(["npm run test"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Python with ruff + pytest", async () => {
    const dir = await repo({ "pyproject.toml": "[project]\nname='x'" });
    try {
      const p = await detectStack(dir);
      expect(p.language).toBe("python");
      expect(p.validation).toEqual(["ruff check .", "pytest"]);
      expect(p.analyzers).toEqual(["ruff"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Rust and Go", async () => {
    const rust = await repo({ "Cargo.toml": "[package]" });
    const go = await repo({ "go.mod": "module x" });
    try {
      expect((await detectStack(rust)).validation).toEqual(["cargo test"]);
      expect((await detectStack(go)).validation).toEqual(["go test ./..."]);
    } finally {
      await rm(rust, { recursive: true, force: true });
      await rm(go, { recursive: true, force: true });
    }
  });

  it("falls back to Makefile/justfile when no language marker applies", async () => {
    const make = await repo({ Makefile: "test:\n\techo hi" });
    const just = await repo({ justfile: "test:\n    echo hi" });
    try {
      expect((await detectStack(make)).validation).toEqual(["make test"]);
      expect((await detectStack(just)).validation).toEqual(["just test"]);
    } finally {
      await rm(make, { recursive: true, force: true });
      await rm(just, { recursive: true, force: true });
    }
  });

  it("prefers a language marker over the Makefile fallback", async () => {
    const dir = await repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      Makefile: "test:",
    });
    try {
      const p = await detectStack(dir);
      expect(p.language).toBe("js-ts");
      expect(p.validation).toEqual(["npm run test"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("describeAnalyzers", () => {
  it("returns catalog entries for known ids and skips unknown ones", () => {
    const lines = describeAnalyzers(["fallow", "nope"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fallow");
    expect(ANALYZER_CATALOG.some((a) => a.id === "fallow")).toBe(true);
  });
});
