/**
 * Unit tests for the permission gate module.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { permissionGate } from "../../src/peer/permission-gate";
import type { Permissions } from "../../src/pi/tool-permissions";

/** Capture the tool_call handler a mock pi registers, so we can drive it directly. */
function captureToolCallHandler(p: Permissions, options?: Parameters<typeof permissionGate>[1]) {
  let handler: ((event: unknown) => unknown) | undefined;
  const pi = {
    on: vi.fn((_event: string, h: (event: unknown) => unknown) => {
      handler = h;
      return () => {};
    }),
  } as unknown as ExtensionAPI;
  permissionGate(p, options)(pi);
  if (!handler) throw new Error("permissionGate did not register a tool_call handler");
  return { handler, on: pi.on as unknown as ReturnType<typeof vi.fn> };
}

const bash = (command: string) => ({ toolName: "bash", input: { command }, toolCallId: "c1" });
const other = { toolName: "read", input: {}, toolCallId: "c2" };
const write = (path: string) => ({ toolName: "write", input: { path }, toolCallId: "c3" });
const edit = (path: string) => ({
  toolName: "edit",
  input: { path, edits: [] },
  toolCallId: "c4",
});

describe("permissionGate", () => {
  it("registers a tool_call handler", () => {
    const { on } = captureToolCallHandler({ read: true, edit: false, shell: false });
    expect(on).toHaveBeenCalledWith("tool_call", expect.any(Function));
  });

  it("permits any command when edit:true (shell on)", () => {
    const { handler } = captureToolCallHandler({ read: true, edit: true, shell: true });
    expect(handler(bash("rm -rf /"))).toBeUndefined();
  });

  it("blocks a denied command for an edit-capable peer and names shell_deny (#132)", () => {
    const { handler } = captureToolCallHandler({
      read: true,
      edit: true,
      shell: true,
      shellDeny: ["npx"],
    });
    const res = handler(bash("cd /repo && npx vitest run test/unit/x.test.ts")) as {
      block?: boolean;
      reason?: string;
    };
    expect(res.block).toBe(true);
    expect(res.reason).toContain("shell_deny");
    expect(handler(bash("bun run test test/unit/x.test.ts"))).toBeUndefined();
  });

  it("allows an allowlisted command when shell:true + edit:false", () => {
    const { handler } = captureToolCallHandler({
      read: true,
      edit: false,
      shell: true,
      shellAllowlist: ["git status"],
    });
    expect(handler(bash("git status"))).toBeUndefined();
  });

  it("default-denies a non-allowlisted command when shell:true + edit:false", () => {
    const { handler } = captureToolCallHandler({
      read: true,
      edit: false,
      shell: true,
      shellAllowlist: ["git status"],
    });
    expect(handler(bash("git push"))).toEqual({
      block: true,
      reason: expect.stringContaining("git push"),
    });
  });

  it("default-denies with an empty allowlist", () => {
    const { handler } = captureToolCallHandler({ read: true, edit: false, shell: true });
    expect(handler(bash("ls"))).toMatchObject({ block: true });
  });

  it("ignores non-bash tools", () => {
    const { handler } = captureToolCallHandler({ read: true, edit: false, shell: false });
    expect(handler(other)).toBeUndefined();
  });
});

// Post-mortem-03 rec 17: one peer wrote two whole files after its small edits
// failed, removing 286 and 200 lines. The scope is what blocks that.
describe("write scope", () => {
  const p: Permissions = { read: true, edit: true, shell: false };
  const scoped = (scope: string[] | undefined, resolvePath?: (path: string) => string) =>
    captureToolCallHandler(p, { writeScope: () => scope, resolvePath }).handler;

  it("leaves the peer unrestricted when the work order declares no scope", () => {
    expect(scoped(undefined)(write("anywhere/at/all.ts"))).toBeUndefined();
  });

  it("allows a write to a declared file", () => {
    expect(scoped(["src/peer/file-lock.ts"])(write("src/peer/file-lock.ts"))).toBeUndefined();
  });

  it("blocks a write outside the declared files, and names them", () => {
    const out = scoped(["src/peer/file-lock.ts"])(write("templates/spec-plan-adversarial.yaml"));
    expect(out).toEqual({
      block: true,
      reason: expect.stringContaining("templates/spec-plan-adversarial.yaml"),
    });
    expect((out as { reason: string }).reason).toContain("src/peer/file-lock.ts");
  });

  it("blocks an edit as well as a whole-file write", () => {
    expect(scoped(["a.ts"])(edit("b.ts"))).toMatchObject({ block: true });
    expect(scoped(["a.ts"])(edit("a.ts"))).toBeUndefined();
  });

  it("blocks all writes when the scope is an empty list", () => {
    const out = scoped([])(write("a.ts"));
    expect(out).toMatchObject({ block: true });
    expect((out as { reason: string }).reason).toContain("no writes");
  });

  it("resolves declared and called paths the same way, so spelling cannot escape", () => {
    const resolvePath = (path: string) => `/repo/${path}`;
    expect(scoped(["src/a.ts"], resolvePath)(write("src/a.ts"))).toBeUndefined();
    // A lexical escape resolves off the declared file, so it is blocked.
    expect(scoped(["src/a.ts"], resolvePath)(write("src/../../etc/hosts"))).toMatchObject({
      block: true,
    });
  });

  it("does not restrict edits to files it never inspects", () => {
    expect(scoped(["a.ts"])(other)).toBeUndefined();
  });
});
