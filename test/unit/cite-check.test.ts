import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCitations,
  findCitations,
  lineCount,
  resolveCitationPath,
} from "../../scripts/cite-check";

describe("findCitations", () => {
  it("extracts path:NN and path:NN-MM, including ~-relative, absolute, and scoped-package paths", () => {
    const text = [
      "a: src/batch/executor.ts:386-402",
      "b: ~/.pi/agent/settings.json:32",
      "c: /abs/root/file.md:5-6",
      "d: /nvm/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:756-761",
    ].join("\n");

    const cits = findCitations(text);
    expect(cits.map((c) => c.path)).toEqual([
      "src/batch/executor.ts",
      "~/.pi/agent/settings.json",
      "/abs/root/file.md",
      "/nvm/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js",
    ]);
    expect(cits.map((c) => c.start)).toEqual([386, 32, 5, 756]);
    expect(cits[0]!.end).toBe(402);
    expect(cits[1]!.end).toBeUndefined();
    expect(cits[2]!.end).toBe(6);
    expect(cits[3]!.end).toBe(761);
  });
});

describe("lineCount", () => {
  it("counts like wc -l, ignoring a trailing newline", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\ntwo")).toBe(2);
    expect(lineCount("one\ntwo\n")).toBe(2);
  });
});

describe("resolveCitationPath", () => {
  it("resolves ~ against the home dir, absolute as-is, relative against cwd", () => {
    expect(resolveCitationPath("~/x/a.ts", "/cwd", "/home")).toBe("/home/x/a.ts");
    expect(resolveCitationPath("/abs/a.ts", "/cwd", "/home")).toBe("/abs/a.ts");
    expect(resolveCitationPath("rel/a.ts", "/cwd", "/home")).toBe("/cwd/rel/a.ts");
  });
});

describe("checkCitations", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cite-check-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes a resolving citation and flags a missing file and an out-of-range line", () => {
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n"); // 2 lines
    const text = [
      "ok single: a.ts:1",
      "ok range: a.ts:1-2",
      "missing: b.ts:1",
      "past end: a.ts:99",
    ].join("\n");

    const failures = checkCitations(text, dir);
    expect(failures.map((f) => f.line)).toEqual([3, 4]);
    expect(failures[0]!.reason).toContain("b.ts");
    expect(failures[0]!.reason).toContain("file not found");
    expect(failures[1]!.reason).toContain("past end of file");
  });

  it("returns no failures when every citation resolves", () => {
    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
    expect(checkCitations("a.ts:3\na.ts:1-3\n", dir)).toEqual([]);
  });
});
