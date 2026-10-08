/**
 * Unit tests for the session scaffolder: portable template + detected stack →
 * a ready session.yaml under `.mypi/<task>/`, without clobbering an existing one.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeTaskName, scaffoldSession, withValidation } from "../../src/pi/scaffold";

const TEMPLATE = "validation:\n  commands: []\n";

describe("withValidation", () => {
  it("fills the empty list with the detected commands", () => {
    const out = withValidation(TEMPLATE, ["bun run test", "bun run typecheck"]);
    expect(out).toBe('validation:\n  commands:\n    - "bun run test"\n    - "bun run typecheck"\n');
  });

  it("leaves the empty list untouched when nothing was detected", () => {
    expect(withValidation(TEMPLATE, [])).toBe(TEMPLATE);
  });
});

describe("safeTaskName", () => {
  it("slugifies and never escapes .mypi", () => {
    expect(safeTaskName("Review Auth")).toBe("Review-Auth");
    expect(safeTaskName("..")).toBe("task");
    expect(safeTaskName("../../etc")).toBe("etc");
    expect(safeTaskName("")).toBe("task");
  });
});

describe("scaffoldSession", () => {
  it("writes .mypi/<task>/session.yaml with detected validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scaf-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      await writeFile(join(dir, "template.yaml"), TEMPLATE);
      const target = await scaffoldSession(dir, join(dir, "template.yaml"), "auth");
      expect(target).toBe(join(dir, ".mypi", "auth", "session.yaml"));
      expect(await readFile(target, "utf8")).toContain('    - "npm run test"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a .mypi/.gitignore that ignores run output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scaf-"));
    try {
      await writeFile(join(dir, "template.yaml"), TEMPLATE);
      await scaffoldSession(dir, join(dir, "template.yaml"));
      expect(await readFile(join(dir, ".mypi", ".gitignore"), "utf8")).toContain("run-details/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defaults the task name to "task"', async () => {
    const dir = await mkdtemp(join(tmpdir(), "scaf-"));
    try {
      await writeFile(join(dir, "template.yaml"), TEMPLATE);
      const target = await scaffoldSession(dir, join(dir, "template.yaml"));
      expect(target).toBe(join(dir, ".mypi", "task", "session.yaml"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing session.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scaf-"));
    try {
      await writeFile(join(dir, "template.yaml"), TEMPLATE);
      await scaffoldSession(dir, join(dir, "template.yaml"), "auth");
      await expect(scaffoldSession(dir, join(dir, "template.yaml"), "auth")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
