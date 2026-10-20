/**
 * Unit tests for session resolution from the ordered `taskDirs` list
 * (issue #57). Seam S2: resolveSessionPath walks taskDirs in order; a named
 * lookup stops at the first match, an unnamed lookup walks every entry and
 * de-duplicates name collisions first-wins.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSessionPath } from "../../src/pi/session-path";

async function writeConfig(dir: string, taskDirs: readonly string[]): Promise<void> {
  const body = taskDirs.map((d) => `  - ${d}`).join("\n");
  await writeFile(join(dir, "mypi-multi-agent.yaml"), `version: 1\ntaskDirs:\n${body}\n`);
}

async function writeTask(dir: string, taskDir: string, name: string): Promise<void> {
  await mkdir(join(dir, taskDir, name), { recursive: true });
  await writeFile(join(dir, taskDir, name, "session.yaml"), "x");
}

describe("resolveSessionPath", () => {
  it("ignores a root session.yaml and resolves from taskDirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeFile(join(dir, "session.yaml"), "root");
      await writeConfig(dir, ["mypi-tasks"]);
      await writeTask(dir, "mypi-tasks", "foo");
      await expect(resolveSessionPath(dir)).resolves.toBe(
        join("mypi-tasks", "foo", "session.yaml"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors project-not-configured when only a root session.yaml exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeFile(join(dir, "session.yaml"), "root");
      await expect(resolveSessionPath(dir)).rejects.toThrow(
        "project not configured to run mypi-multi-agent",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a path-shaped argument as a task name and reports not found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeConfig(dir, ["mypi-tasks"]);
      await expect(resolveSessionPath(dir, "sub/foo.yaml")).rejects.toThrow(
        "task 'sub/foo.yaml' not found under taskDirs",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a bare name from a single taskDirs entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeConfig(dir, ["mypi-tasks"]);
      await writeTask(dir, "mypi-tasks", "auth");
      await expect(resolveSessionPath(dir, "auth")).resolves.toBe(
        join("mypi-tasks", "auth", "session.yaml"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a bare name found only in the second taskDirs entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeConfig(dir, ["mypi-tasks", ".mypi"]);
      await writeTask(dir, ".mypi", "auth");
      await expect(resolveSessionPath(dir, "auth")).resolves.toBe(
        join(".mypi", "auth", "session.yaml"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a name in two dirs to the first taskDirs entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeConfig(dir, ["mypi-tasks", ".mypi"]);
      await writeTask(dir, "mypi-tasks", "auth");
      await writeTask(dir, ".mypi", "auth");
      await expect(resolveSessionPath(dir, "auth")).resolves.toBe(
        join("mypi-tasks", "auth", "session.yaml"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors project-not-configured when a bare name needs a config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await expect(resolveSessionPath(dir, "auth")).rejects.toThrow(
        "project not configured to run mypi-multi-agent",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors when a bare name is missing from every taskDirs entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeConfig(dir, ["mypi-tasks", ".mypi"]);
      await expect(resolveSessionPath(dir, "nope")).rejects.toThrow(
        "task 'nope' not found under taskDirs",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a name collision across taskDirs to the first entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeConfig(dir, ["mypi-tasks", ".mypi"]);
      await writeTask(dir, "mypi-tasks", "a");
      await writeTask(dir, ".mypi", "a");
      await expect(resolveSessionPath(dir)).resolves.toBe(join("mypi-tasks", "a", "session.yaml"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors multiple-session.yaml when distinct tasks exist across taskDirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeConfig(dir, ["mypi-tasks", ".mypi"]);
      await writeTask(dir, "mypi-tasks", "a");
      await writeTask(dir, ".mypi", "b");
      await expect(resolveSessionPath(dir)).rejects.toThrow(
        "multiple session.yaml found — specify one",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds a task only in the second dir when no name is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeConfig(dir, ["mypi-tasks", ".mypi"]);
      await writeTask(dir, ".mypi", "b");
      await expect(resolveSessionPath(dir)).resolves.toBe(join(".mypi", "b", "session.yaml"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors no-session.yaml-found when the config has no tasks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      await writeConfig(dir, ["mypi-tasks"]);
      await expect(resolveSessionPath(dir)).rejects.toThrow("no session.yaml found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
