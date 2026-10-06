import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { canShell, type Permissions } from "../pi/tool-permissions";

/**
 * Inline extension enforcing the shell allowlist at the tool layer (spec 13.1).
 * `bash` is enabled by toolsForPermissions for any shell:true peer; this hook
 * default-denies every command unless the permissions allow it (edit:true, or
 * an exact allowlist match when edit:false).
 */
export function permissionGate(p: Permissions): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", (event: ToolCallEvent) => {
      if (!isToolCallEventType("bash", event)) return undefined;
      const command = event.input.command;
      if (!canShell(p, command)) {
        return { block: true, reason: `command "${command}" is not shell-allowed` };
      }
      return undefined;
    });
  };
}
