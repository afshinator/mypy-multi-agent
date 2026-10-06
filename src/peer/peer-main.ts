import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { handleWorkOrder, type SessionResult, type SessionUsage } from "./peer-harness";
import { toolsForPermissions, type PeerConfig } from "./peer-config";
import { StatusAdapter } from "../herdr/status-adapter";
import { HerdrCliClient } from "../herdr/herdr-client";
import type { A2AEnvelope } from "../contracts/a2a-schema";

/**
 * Headless peer harness entry point (live glue, not unit-tested). Reads its
 * per-peer config, resolves its model, runs one Pi SDK session per work order,
 * reports back (with usage), and streams collapsed status to its herdr pane.
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

const paneId = process.env.HERDR_PANE_ID;
const status = paneId ? new StatusAdapter(new HerdrCliClient(), "peer") : undefined;
const setStatus = (state: string, cost?: string, tokens?: string, title?: string): void => {
  if (status && paneId) void status.setStatus(paneId, { state, cost, tokens, title });
};

socket.on("connect", () => {
  setStatus("STARTING");
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

const runSession = async (prompt: string): Promise<SessionResult> => {
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
  let usage: SessionUsage | undefined;
  const unsub = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(e.assistantMessageEvent.delta);
    }
    if (e.type === "message_end") {
      const m = e.message as { role?: string; usage?: { cost: { total: number }; totalTokens: number } };
      if (m.role === "assistant" && m.usage) {
        usage = { cost: m.usage.cost.total, tokens: m.usage.totalTokens };
      }
    }
  });
  try {
    await session.prompt(prompt);
    return { report: session.getLastAssistantText() ?? "", usage };
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
      setStatus("WORKING", undefined, undefined, action);
      void handleWorkOrder(cfg.agentId, action, { runSession, send, now: Date.now })
        .then((result) => {
          setStatus(
            "DONE",
            result.usage ? String(result.usage.cost) : undefined,
            result.usage ? String(result.usage.tokens) : undefined,
          );
        })
        .catch((e) => console.error(e));
    }
  }
});
