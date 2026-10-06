import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionPath } from "../../src/pi/session-path";

describe("resolveSessionPath", () => {
  it("returns an explicit file path unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeFile(join(dir, "custom.yaml"), "x");
      await expect(resolveSessionPath(dir, "custom.yaml")).resolves.toBe("custom.yaml");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves an explicit directory to its session.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await mkdir(join(dir, "task"));
      await writeFile(join(dir, "task", "session.yaml"), "x");
      await expect(resolveSessionPath(dir, "task")).resolves.toBe(join("task", "session.yaml"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors when an explicit path has no session.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await mkdir(join(dir, "empty"));
      await expect(resolveSessionPath(dir, "empty")).rejects.toThrow("no session.yaml");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds session.yaml in the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeFile(join(dir, "session.yaml"), "x");
      await expect(resolveSessionPath(dir)).resolves.toBe("session.yaml");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds session.yaml one level down", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await mkdir(join(dir, "task"));
      await writeFile(join(dir, "task", "session.yaml"), "x");
      await expect(resolveSessionPath(dir)).resolves.toBe(join("task", "session.yaml"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors when none found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await expect(resolveSessionPath(dir)).rejects.toThrow("no session.yaml");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors when multiple are found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeFile(join(dir, "session.yaml"), "x");
      await mkdir(join(dir, "a"));
      await writeFile(join(dir, "a", "session.yaml"), "x");
      await mkdir(join(dir, "b"));
      await writeFile(join(dir, "b", "session.yaml"), "x");
      await expect(resolveSessionPath(dir)).rejects.toThrow("multiple session.yaml");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
