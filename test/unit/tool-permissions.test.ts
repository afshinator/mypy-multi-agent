/**
 * Unit tests for the tool permissions module.
 */
import { describe, expect, it } from "vitest";
import { canShell, type Permissions } from "../../src/pi/tool-permissions";

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
    expect(
      canShell(p({ shell: true, edit: false, shellAllowlist: ["git status"] }), "git status"),
    ).toBe(true);
  });

  it("shell on + edit off blocks a non-allowlisted command", () => {
    expect(
      canShell(p({ shell: true, edit: false, shellAllowlist: ["git status"] }), "git push"),
    ).toBe(false);
  });

  it("obvious mutating unlisted command blocks", () => {
    expect(
      canShell(p({ shell: true, edit: false, shellAllowlist: ["git status"] }), "rm -rf /"),
    ).toBe(false);
  });

  it("shell on + edit on allows anything", () => {
    expect(canShell(p({ shell: true, edit: true }), "rm -rf /")).toBe(true);
  });
});
