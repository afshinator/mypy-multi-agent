/**
 * Unit tests for the launcher's pure contract (the herdr bootstrap plan). The
 * live spawn is exercised only in a real herdr environment.
 */

import { describe, expect, it } from "vitest";
import {
  buildLaunchPlan,
  classifyDirtyTree,
  decideLaunchGuard,
  inHerdr,
} from "../../src/pi/launch";

describe("inHerdr", () => {
  it("is true only when both herdr markers are set", () => {
    expect(inHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "p1" })).toBe(true);
    expect(inHerdr({ HERDR_ENV: "1" })).toBe(false);
    expect(inHerdr({ HERDR_PANE_ID: "p1" })).toBe(false);
    expect(inHerdr({})).toBe(false);
  });
});

describe("buildLaunchPlan", () => {
  it("creates a focused supervisor workspace at the target dir", () => {
    const plan = buildLaunchPlan("/tmp/repo");
    expect(plan.createArgs).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/tmp/repo",
      "--label",
      "mypi-supervisor",
      "--focus",
      "--env",
      "SHELL_SESSIONS_DISABLE=1",
    ]);
    expect(plan.paneCommand).toBe('pi; herdr pane close "$HERDR_PANE_ID"');
  });

  it("default pane command stays byte-identical", () => {
    expect(buildLaunchPlan("/tmp/repo").paneCommand).toBe('pi; herdr pane close "$HERDR_PANE_ID"');
  });

  it("resume flag switches the pane command to the explicit --resume entry point", () => {
    const plan = buildLaunchPlan("/tmp/repo", "mypi-supervisor", true);
    expect(plan.paneCommand).toBe(
      'pi "/mypi-multi-agent --resume"; herdr pane close "$HERDR_PANE_ID"',
    );
  });
});

describe("classifyDirtyTree", () => {
  it("allows a clean tree", () => {
    expect(classifyDirtyTree("", ["mypi-tasks"])).toEqual({ allow: true, dirtyPaths: [] });
  });

  it("refuses tracked changes outside the task dirs", () => {
    const status = [
      " M README.md",
      "A  src/pi/launch.ts",
      " D docs/architecture.md",
      "R  old.txt -> src/new.txt",
    ].join("\n");
    const result = classifyDirtyTree(status, ["mypi-tasks"]);
    expect(result.allow).toBe(false);
    expect(result.dirtyPaths).toEqual([
      "README.md",
      "src/pi/launch.ts",
      "docs/architecture.md",
      "src/new.txt",
    ]);
  });

  it("refuses untracked files outside the task dirs", () => {
    const result = classifyDirtyTree("?? notes.txt", ["mypi-tasks"]);
    expect(result).toEqual({ allow: false, dirtyPaths: ["notes.txt"] });
  });

  it("allows changes only under a task dir", () => {
    const status = [
      " M mypi-tasks/07/session.yaml",
      "?? mypi-tasks/07/new.txt",
      "R  mypi-tasks/07/old -> mypi-tasks/07/new.yaml",
    ].join("\n");
    expect(classifyDirtyTree(status, ["mypi-tasks"])).toEqual({ allow: true, dirtyPaths: [] });
  });

  it("uses the rename target, not the source, to decide task-dir membership", () => {
    expect(classifyDirtyTree("R  mypi-tasks/07/old -> README.md", ["mypi-tasks"])).toEqual({
      allow: false,
      dirtyPaths: ["README.md"],
    });
    expect(classifyDirtyTree("R  old.txt -> mypi-tasks/07/new.txt", ["mypi-tasks"])).toEqual({
      allow: true,
      dirtyPaths: [],
    });
  });
});

describe("decideLaunchGuard", () => {
  const taskDirs = ["mypi-tasks"];

  it("refuses a dirty tree by default", () => {
    expect(
      decideLaunchGuard({ resume: false, allowDirty: false }, " M README.md", taskDirs),
    ).toEqual({ action: "refuse", dirtyPaths: ["README.md"] });
  });

  it("--allow-dirty overrides the guard", () => {
    expect(
      decideLaunchGuard({ resume: false, allowDirty: true }, " M README.md", taskDirs),
    ).toEqual({ action: "launch", dirtyPaths: [] });
  });

  it("--resume skips the guard", () => {
    expect(
      decideLaunchGuard({ resume: true, allowDirty: false }, " M README.md", taskDirs),
    ).toEqual({ action: "launch", dirtyPaths: [] });
  });
});
