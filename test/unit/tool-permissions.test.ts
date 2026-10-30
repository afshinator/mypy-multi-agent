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

  it("blocks a denied command even when edit:true would otherwise allow it (#132)", () => {
    const perms = p({ shell: true, edit: true, shellDeny: ["npx"] });
    expect(canShell(perms, "npx vitest run test/unit/x.test.ts")).toBe(false);
    // The observed shape is `cd <dir> && <command>`, so the deny looks at every segment.
    expect(canShell(perms, "cd /repo && npx vitest run test/unit/x.test.ts")).toBe(false);
    expect(canShell(perms, "bun run test test/unit/x.test.ts")).toBe(true);
  });

  it("denies whole words only, and outranks the allowlist (#132)", () => {
    const denied = p({ shell: true, edit: true, shellDeny: ["npx"] });
    expect(canShell(denied, "npxfoo --version")).toBe(true);
    expect(canShell(denied, "echo npx")).toBe(true);
    const allowed = p({
      shell: true,
      edit: false,
      shellAllowlist: ["npx vitest"],
      shellDeny: ["npx"],
    });
    expect(canShell(allowed, "npx vitest")).toBe(false);
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
