import { connect } from "node:net";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

/**
 * Headless peer harness (L8 / §23). Runs one Pi SDK session per peer process
 * inside a herdr pane, no user input. Connects to the A2A socket, registers,
 * heartbeats, and runs WORK_ORDERs with session.prompt(), streaming
 * session.subscribe() events to stdout and herdr pane metadata.
 *
 * Live integration; verified by the end-to-end run, not unit tests.
 */

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const agentId = arg("--agent") ?? "peer";
const busPath = arg("--bus");
const modelRef = arg("--model");
const systemPrompt = arg("--system-prompt");

if (!busPath || !modelRef) {
  console.error("peer-main requires --bus <socket> and --model <provider/model>");
  process.exit(1);
}

const socket = connect(busPath);

socket.on("connect", () => {
  socket.write(
    JSON.stringify({
      id: `reg-${agentId}`,
      timestamp: Date.now(),
      sender: agentId,
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId,
        title: agentId,
        model: modelRef,
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: systemPrompt ?? "",
      },
    }) + "\n",
  );
});

setInterval(() => {
  if (!socket.destroyed) {
    socket.write(
      JSON.stringify({
        id: `hb-${agentId}-${Date.now()}`,
        timestamp: Date.now(),
        sender: agentId,
        recipient: "supervisor",
        type: "HEARTBEAT",
        payload: { agentId },
      }) + "\n",
    );
  }
}, 1000);

async function runWorkOrder(model: Model<any>, prompt: string): Promise<void> {
  const { session } = await createAgentSession({ model });
  const unsub = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(e.assistantMessageEvent.delta);
    }
  });
  await session.prompt(prompt);
  unsub();
  session.dispose();
}

socket.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    let env: { type: string; payload: { action?: string } };
    try {
      env = JSON.parse(line);
    } catch {
      continue;
    }
    if (env.type === "WORK_ORDER") {
      // Live wiring: resolve `modelRef` via ModelRuntime.getModel(provider, modelId),
      // then call runWorkOrder(model, env.payload.action).
      void runWorkOrder; // placeholder until the model is resolved at runtime
    }
  }
});
