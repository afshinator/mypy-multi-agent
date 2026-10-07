/**
 * pi extension enforcing the shell allowlist at the tool layer (spec 13.1):
 * blocks bash calls that permissions do not allow.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { canShell, type Permissions } from "../pi/tool-permissions";

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
