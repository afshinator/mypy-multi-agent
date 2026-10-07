/**
 * Unit tests for the tool permissions module.
 */
import { describe, expect, it } from "vitest";
import { canRead, canEdit, canShell, type Permissions } from "../../src/pi/tool-permissions";

const p = (over: Partial<Permissions> = {}): Permissions => ({
  read: true,
  edit: false,
  shell: false,
  ...over,
});

describe("tool-permissions", () => {
  it("shell off blocks all shell", () => {
    expect(canShell(p({ shell: false }), "git status")).toBe(false);
  });

  it("shell on + edit off allows an allowlisted command", () => {
    expect(canShell(p({ shell: true, edit: false, shellAllowlist: ["git status"] }), "git status")).toBe(true);
  });

  it("shell on + edit off blocks a non-allowlisted command", () => {
    expect(canShell(p({ shell: true, edit: false, shellAllowlist: ["git status"] }), "git push")).toBe(false);
  });

  it("obvious mutating unlisted command blocks", () => {
    expect(canShell(p({ shell: true, edit: false, shellAllowlist: ["git status"] }), "rm -rf /")).toBe(false);
  });

  it("shell on + edit on allows anything", () => {
    expect(canShell(p({ shell: true, edit: true }), "rm -rf /")).toBe(true);
  });

  it("edit off blocks write", () => {
    expect(canEdit(p({ edit: false }))).toBe(false);
  });

  it("edit on reaches the lock path", () => {
    expect(canEdit(p({ edit: true }))).toBe(true);
  });

  it("read permission", () => {
    expect(canRead(p({ read: true }))).toBe(true);
    expect(canRead(p({ read: false }))).toBe(false);
  });
});
