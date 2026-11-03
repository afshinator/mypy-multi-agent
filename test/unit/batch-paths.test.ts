/**
 * Tests for the batch record path helpers (issue #264): the record root is
 * `<taskDirs[0]>/<batchDir>`, defaulting when the repo has no config.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batchDirOf, recordRoot, taskDirOf } from "../../src/batch/paths";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mypi-paths-"));
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("taskDirOf", () => {
  it("reads the first configured task dir", () => {
    writeFileSync(join(cwd, "mypi-multi-agent.yaml"), "version: 1\ntaskDirs:\n  - tasks\n");
    expect(taskDirOf(cwd)).toBe("tasks");
  });

  it("answers nothing when the repo has no config", () => {
    expect(taskDirOf(cwd)).toBeUndefined();
  });
});

describe("batchDirOf", () => {
  it("reads the configured record segment", () => {
    writeFileSync(
      join(cwd, "mypi-multi-agent.yaml"),
      "version: 1\ntaskDirs:\n  - tasks\nbatchDir: records\n",
    );
    expect(batchDirOf(cwd)).toBe("records");
  });

  it("defaults to 000-batches with no config", () => {
    expect(batchDirOf(cwd)).toBe("000-batches");
  });
});

describe("recordRoot", () => {
  it("is <taskDirs[0]>/000-batches by default", () => {
    writeFileSync(join(cwd, "mypi-multi-agent.yaml"), "version: 1\ntaskDirs:\n  - mypi-tasks\n");
    expect(recordRoot(cwd)).toBe("mypi-tasks/000-batches");
  });

  it("moves with a configured batchDir", () => {
    writeFileSync(
      join(cwd, "mypi-multi-agent.yaml"),
      "version: 1\ntaskDirs:\n  - mypi-tasks\nbatchDir: records\n",
    );
    expect(recordRoot(cwd)).toBe("mypi-tasks/records");
  });

  it("falls back to mypi-tasks/000-batches with no config", () => {
    expect(recordRoot(cwd)).toBe("mypi-tasks/000-batches");
  });
});
