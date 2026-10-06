import { connect } from "node:net";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { handleWorkOrder } from "./peer-harness";
import type { A2AEnvelope } from "../contracts/a2a-schema";

/**
 * Headless peer harness entry point (live glue, not unit-tested). Runs one Pi
 * SDK session per work order inside a herdr pane. Model resolution and the
 * session runner are the live boundaries; the work-order orchestration lives
 * in peer-harness.ts (tested).
 */

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const agentId = arg("--agent") ?? "peer";
const busPath = arg("--bus");
const modelRef = arg("--model");

if (!busPath || !modelRef) {
  console.error("peer-main requires --bus <socket> and --model <provider/model>");
  process.exit(1);
}

const runtime = await ModelRuntime.create();
const slash = modelRef.indexOf("/");
const model = slash > 0 ? runtime.getModel(modelRef.slice(0, slash), modelRef.slice(slash + 1)) : undefined;
if (!model) {
  console.error(`model not found: ${modelRef}`);
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
        systemPrompt: "",
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

const send = (env: A2AEnvelope): void => {
  if (!socket.destroyed) socket.write(JSON.stringify(env) + "\n");
};

const runSession = async (prompt: string): Promise<string> => {
  const { session } = await createAgentSession({ model, modelRuntime: runtime });
  const unsub = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(e.assistantMessageEvent.delta);
    }
  });
  try {
    await session.prompt(prompt);
    return session.getLastAssistantText() ?? "";
  } finally {
    unsub();
    session.dispose();
  }
};

socket.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    let env: A2AEnvelope;
    try {
      env = JSON.parse(line);
    } catch {
      continue;
    }
    if (env.type === "WORK_ORDER") {
      const action = (env.payload as { action: string }).action;
      void handleWorkOrder(agentId, action, { runSession, send, now: Date.now }).catch((e) => console.error(e));
    }
  }
});
