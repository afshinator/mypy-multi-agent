/**
 * Unit tests for the session scaffolder: portable template + detected stack →
 * a ready session.yaml, without clobbering an existing one.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffoldSession, withValidation } from "../../src/pi/scaffold";

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

describe("scaffoldSession", () => {
  it("writes session.yaml with validation detected from the repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scaf-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      await writeFile(join(dir, "template.yaml"), TEMPLATE);
      const target = await scaffoldSession(dir, join(dir, "template.yaml"));
      expect(target).toBe(join(dir, "session.yaml"));
      expect(await readFile(target, "utf8")).toContain('    - "npm run test"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing session.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scaf-"));
    try {
      await writeFile(join(dir, "session.yaml"), "existing");
      await writeFile(join(dir, "template.yaml"), TEMPLATE);
      await expect(scaffoldSession(dir, join(dir, "template.yaml"))).rejects.toThrow();
      expect(await readFile(join(dir, "session.yaml"), "utf8")).toBe("existing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
