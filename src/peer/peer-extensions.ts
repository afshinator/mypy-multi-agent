/**
 * Which extensions a peer loads, and in what order, is policy — so it lives here
 * as one exported function instead of inline in the process entry point.
 *
 * The order matters: the permission gate must see a tool call before the logger
 * records it, and the lock must be held before anything touches the tree.
 */

import type { A2AEnvelope } from "../contracts/a2a-schema";
import type { ConversationLog } from "../logging/conversation-log";
import type { Permissions } from "../pi/tool-permissions";
import { toolResultHint } from "../pi/tool-result-hint";
import type { PeerTraceState } from "../tracing/peer-trace";
import { changeNotifier } from "./change-notifier";
import type { FileLock } from "./file-lock";
import { fileLock } from "./file-lock";
import { permissionGate } from "./permission-gate";
import { toolCallLogger } from "./tool-call-logger";
import { webTool } from "./web-tool";

export interface PeerExtensionDeps {
  permissions: Permissions;
  /** The current work order's write scope; `undefined` means unrestricted. */
  writeScope: () => string[] | undefined;
  resolvePath: (path: string) => string;
  agentId: string;
  log: ConversationLog;
  trace: PeerTraceState;
  send: (env: A2AEnvelope) => void;
  locks: FileLock;
}

/** Named so a test can pin the set and the order without spawning a peer. */
export interface NamedExtension {
  name: string;
  factory: ReturnType<typeof permissionGate>;
}

export function peerExtensions(deps: PeerExtensionDeps): NamedExtension[] {
  return [
    {
      name: "permission-gate",
      factory: permissionGate(deps.permissions, {
        writeScope: deps.writeScope,
        resolvePath: deps.resolvePath,
      }),
    },
    {
      name: "tool-call-logger",
      factory: toolCallLogger(deps.agentId, deps.log, deps.trace),
    },
    { name: "change-notifier", factory: changeNotifier(deps.agentId, deps.send) },
    { name: "file-lock", factory: fileLock(deps.locks) },
    { name: "web-tool", factory: webTool() },
    { name: "tool-result-hint", factory: toolResultHint() },
  ];
}
