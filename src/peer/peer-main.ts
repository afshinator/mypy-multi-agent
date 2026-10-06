import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { handleWorkOrder } from "./peer-harness";
import { toolsForPermissions, type PeerConfig } from "./peer-config";
import type { A2AEnvelope } from "../contracts/a2a-schema";

/**
 * Headless peer harness entry point (live glue, not unit-tested). Reads its
 * per-peer config, resolves its model, runs one Pi SDK session per work order,
 * and reports back. Model resolution + session running are the live boundary;
 * orchestration lives in peer-harness.ts, config mapping in peer-config.ts.
 */

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const cfgPath = arg("--config");
if (!cfgPath) {
  console.error("peer-main requires --config <path>");
  process.exit(1);
}

const cfg: PeerConfig = JSON.parse(await readFile(cfgPath, "utf8"));

const runtime = await ModelRuntime.create();
const slash = cfg.model.indexOf("/");
const model = slash > 0 ? runtime.getModel(cfg.model.slice(0, slash), cfg.model.slice(slash + 1)) : undefined;
if (!model) {
  console.error(`model not found: ${cfg.model}`);
  process.exit(1);
}

const socket = connect(cfg.busPath);

socket.on("connect", () => {
  socket.write(
    JSON.stringify({
      id: `reg-${cfg.agentId}`,
      timestamp: Date.now(),
      sender: cfg.agentId,
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId: cfg.agentId,
        title: cfg.agentId,
        model: cfg.model,
        permissions: cfg.permissions,
        maxCostUsd: cfg.maxCostUsd,
        maxTokens: cfg.maxTokens,
        systemPrompt: cfg.systemPrompt,
      },
    }) + "\n",
  );
});

setInterval(() => {
  if (!socket.destroyed) {
    socket.write(
      JSON.stringify({
        id: `hb-${cfg.agentId}-${Date.now()}`,
        timestamp: Date.now(),
        sender: cfg.agentId,
        recipient: "supervisor",
        type: "HEARTBEAT",
        payload: { agentId: cfg.agentId },
      }) + "\n",
    );
  }
}, 1000);

const send = (env: A2AEnvelope): void => {
  if (!socket.destroyed) socket.write(JSON.stringify(env) + "\n");
};

const runSession = async (prompt: string): Promise<string> => {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => cfg.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    model,
    modelRuntime: runtime,
    tools: toolsForPermissions(cfg.permissions),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });
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
      void handleWorkOrder(cfg.agentId, action, { runSession, send, now: Date.now }).catch((e) => console.error(e));
    }
  }
});
