/**
 * pi extension enforcing a peer's permissions at the tool layer (spec 13.1):
 * blocks bash commands the permissions do not allow, and edits or writes to a
 * file outside the current work order's declared write scope.
 *
 * The scope is the supervisor's declaration, not a second permission model: a
 * work order with no `writeScope` leaves the peer free to write anywhere, as
 * before, so a run opts in one work order at a time (post-mortem-03 rec 17). The
 * gap it closes is real — a peer whose small edits failed wrote two whole files,
 * removing 286 and 200 lines.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { canShell, isDeniedShell, type Permissions } from "../pi/tool-permissions";

export interface GateOptions {
  /** Paths the current work order permits; `undefined` means no restriction. */
  writeScope?: () => readonly string[] | undefined;
  /** Resolve a path as the file lock does, so a declared scope and a call agree. */
  resolvePath?: (path: string) => string;
}

export function permissionGate(
  p: Permissions,
  options: GateOptions = {},
): (pi: ExtensionAPI) => void {
  const resolvePath = options.resolvePath ?? ((path: string) => path);
  return (pi) => {
    pi.on("tool_call", (event: ToolCallEvent) => {
      if (isToolCallEventType("bash", event)) {
        const command = event.input.command;
        if (!canShell(p, command)) {
          // Name the rule that fired: a peer told only "not allowed" retries
          // variants of the denied command instead of the project runner.
          const reason = isDeniedShell(p, command)
            ? `command "${command}" is denied by shell_deny (${(p.shellDeny ?? []).join(", ")}) — use the project runner`
            : `command "${command}" is not shell-allowed`;
          return { block: true, reason };
        }
        return undefined;
      }
      const path = writePath(event);
      if (path === undefined) return undefined;
      const declared = options.writeScope?.();
      // No declaration means no restriction: absent is not the same as empty.
      if (declared === undefined) return undefined;
      if (declared.map(resolvePath).includes(resolvePath(path))) return undefined;
      return {
        block: true,
        reason:
          declared.length === 0
            ? `the current work order permits no writes; "${path}" is blocked`
            : `"${path}" is outside the work order's writeScope (${declared.join(", ")})`,
      };
    });
  };
}

/** The path an edit or write tool call would change; other tools have none. */
function writePath(event: ToolCallEvent): string | undefined {
  if (isToolCallEventType("edit", event)) return event.input.path;
  if (isToolCallEventType("write", event)) return event.input.path;
  return undefined;
}
