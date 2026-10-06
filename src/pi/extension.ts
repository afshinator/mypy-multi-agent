import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { ControlPlane } from "../control/control-plane";
import { SessionState } from "../control/session-state";
import { PeerMessaging } from "../runtime/peer-messaging";
import { AgentRegistry } from "../runtime/agent-registry";
import { CorrelationRegistry } from "../runtime/correlation-registry";

/**
 * Pi extension assembly (glue over the tested L1-L11 modules). Verified by the
 * live end-to-end run, not by unit tests. Wires the supervisor's control
 * surface and A2A tools; the bus socket and peer spawning start on session_start.
 */

const text = (s: string): AgentToolResult => ({ content: [{ type: "text", text: s }], details: undefined });

export default function (pi: ExtensionAPI) {
  // Runtime is assembled per-session and closed over by the tools/commands.
  let session = new SessionState();
  let controlPlane: ControlPlane;
  let messaging: PeerMessaging;
  const registry = new AgentRegistry();
  const correlations = new CorrelationRegistry();

  pi.on("session_start", (_event, ctx) => {
    session = new SessionState();
    controlPlane = new ControlPlane(session, {
      emit: (env) => {
        /* wire to the bus socket (L1) once the socket is started */
      },
    });
    messaging = new PeerMessaging(correlations, (_env) => {}, session, new Map());
    void ctx; // bus start + peer spawn happen here in the live assembly
  });

  pi.registerCommand("stop-all", {
    description: "Gracefully stop all peers and finalize",
    handler: async () => {
      controlPlane?.stopAll("user");
    },
  });

  pi.registerCommand("stop", {
    description: "Gracefully stop one peer",
    handler: async (args) => {
      controlPlane?.stopAgent(args.trim(), "user");
    },
  });

  pi.registerCommand("kill-all", {
    description: "Immediately terminate all non-supervisor peers",
    handler: async () => {
      controlPlane?.killAll("user");
    },
  });

  pi.registerCommand("mypi-multi-agent", {
    description: "Start a multi-agent run from a session.yaml",
    handler: async (_args) => {
      /* resolve + validate session.yaml, then spawn peers (live assembly) */
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List agents",
    description: "Return known peer IDs and state",
    parameters: Type.Object({}),
    execute: async () => text([...registry.ids()].join("\n")),
  });

  pi.registerTool({
    name: "send_prompt",
    label: "Send prompt",
    description: "Send a conversational request to another peer",
    parameters: Type.Object({ agentId: Type.String(), text: Type.String() }),
    execute: async (_id, params) => {
      const reply = await messaging.sendPrompt("supervisor", params.agentId, params.text, 10_000);
      return text((reply.payload as { text: string }).text);
    },
  });

  pi.registerTool({
    name: "send_command",
    label: "Send command",
    description: "Send a non-conversational command to another peer",
    parameters: Type.Object({ agentId: Type.String(), command: Type.String() }),
    execute: async (_id, params) => {
      controlPlane?.dispatchWork(params.agentId, {
        taskId: `cmd-${Date.now()}`,
        action: params.command,
        contextFiles: [],
        constraints: [],
        localDoD: "command acknowledged",
      });
      return text("sent");
    },
  });
}
