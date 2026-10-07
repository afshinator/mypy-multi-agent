/**
 * Unit tests for the permission gate module.
 */
import { describe, expect, it, vi } from "vitest";
import { permissionGate } from "../../src/peer/permission-gate";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Permissions } from "../../src/pi/tool-permissions";

/** Capture the tool_call handler a mock pi registers, so we can drive it directly. */
function captureToolCallHandler(p: Permissions) {
  let handler: ((event: unknown) => unknown) | undefined;
  const pi = {
    on: vi.fn((_event: string, h: (event: unknown) => unknown) => {
      handler = h;
      return () => {};
    }),
  } as unknown as ExtensionAPI;
  permissionGate(p)(pi);
  if (!handler) throw new Error("permissionGate did not register a tool_call handler");
  return { handler, on: pi.on as unknown as ReturnType<typeof vi.fn> };
}

const bash = (command: string) => ({ toolName: "bash", input: { command }, toolCallId: "c1" });
const other = { toolName: "read", input: {}, toolCallId: "c2" };

describe("permissionGate", () => {
  it("registers a tool_call handler", () => {
    const { on } = captureToolCallHandler({ read: true, edit: false, shell: false });
    expect(on).toHaveBeenCalledWith("tool_call", expect.any(Function));
  });

  it("permits any command when edit:true (shell on)", () => {
    const { handler } = captureToolCallHandler({ read: true, edit: true, shell: true });
    expect(handler(bash("rm -rf /"))).toBeUndefined();
  });

  it("allows an allowlisted command when shell:true + edit:false", () => {
    const { handler } = captureToolCallHandler({ read: true, edit: false, shell: true, shellAllowlist: ["git status"] });
    expect(handler(bash("git status"))).toBeUndefined();
  });

  it("default-denies a non-allowlisted command when shell:true + edit:false", () => {
    const { handler } = captureToolCallHandler({ read: true, edit: false, shell: true, shellAllowlist: ["git status"] });
    expect(handler(bash("git push"))).toEqual({ block: true, reason: expect.stringContaining("git push") });
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
