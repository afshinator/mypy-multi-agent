// fallow-ignore-file unused-file
/**
 * Headless peer process entry point: parses argv, connects to the bus socket,
 * registers, heartbeats, and serves WORK_ORDER/PROMPT over one persistent pi
 * session. Side-effect script with no exports (runs on import, exits 1 on a bad
 * bootstrap), so it is live glue rather than unit-tested. Streams raw assistant
 * text to stdout (the herdr pane text channel) and collapsed state/cost to the
 * pane via StatusAdapter; logs tool calls to tool-calls.jsonl beside the bus.
 */
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { handleInboundLine, type InboundDeps, type SessionResult } from "./peer-harness";
import { toolsForPermissions, type PeerConfig } from "./peer-config";
import { permissionGate } from "./permission-gate";
import { toolCallLogger } from "./tool-call-logger";
import { webTool } from "./web-tool";
import { PeerSession } from "./peer-session";
import { ConversationLog } from "../logging/conversation-log";
import type { Permissions } from "../pi/tool-permissions";
import { StatusAdapter } from "../herdr/status-adapter";
import { HerdrCliClient } from "../herdr/herdr-client";
import { JsonlFramer } from "../bus/jsonl-framer";
import type { A2AEnvelope } from "../contracts/a2a-schema";

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
// cfg.model is `provider/model`; anything without `/` falls through to "not found".
const model = slash > 0 ? runtime.getModel(cfg.model.slice(0, slash), cfg.model.slice(slash + 1)) : undefined;
if (!model) {
  console.error(`model not found: ${cfg.model}`);
  process.exit(1);
}

const socket = connect(cfg.busPath);
const askDir = dirname(cfg.busPath);
// Tool-call log lives beside the bus socket in the ask dir, not the workspace.
const toolLog = new ConversationLog(join(askDir, "tool-calls.jsonl"));
const permissions: Permissions = { ...cfg.permissions, shellAllowlist: cfg.shellAllowlist };

const paneId = process.env.HERDR_PANE_ID;
const status = paneId ? new StatusAdapter(new HerdrCliClient(), "peer") : undefined;
const setStatus = (state: string, cost?: string, tokens?: string, title?: string): void => {
  if (status && paneId) void status.setStatus(paneId, { state, cost, tokens, title, role: cfg.title, model: cfg.model });
};

socket.on("connect", () => {
  setStatus("STARTING", undefined, undefined, cfg.agentId);
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

// Fixed 1s heartbeat; this interval is also what keeps the process alive, so it
// must be released (via exit on close) or the peer orphans after the bus dies.
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

// One persistent session per peer, reused across all turns until the ask ends.
const peer = new PeerSession({
  createSession: async () => {
    const loader = new DefaultResourceLoader({
      cwd: cfg.workspaceRoot,
      agentDir: getAgentDir(),
      systemPromptOverride: () => cfg.systemPrompt,
      appendSystemPromptOverride: () => [],
      extensionFactories: [permissionGate(permissions), toolCallLogger(cfg.agentId, toolLog), webTool()],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: cfg.workspaceRoot,
      model,
      modelRuntime: runtime,
      tools: toolsForPermissions(cfg.permissions),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    return session;
  },
  // Raw, unbuffered, no newline: stdout is the herdr pane's text channel.
  onTextDelta: (delta) => process.stdout.write(delta),
});

// The heartbeat interval above holds the event loop open after the bus dies;
// exit explicitly so a disconnected peer does not linger as an orphan.
socket.on("close", () => {
  peer.dispose();
  process.exit(0);
});
socket.on("error", (err) => {
  console.error(`bus socket error: ${(err as Error).message}`);
  process.exit(1);
});

const runPrompt = (prompt: string): Promise<SessionResult> => {
  setStatus("WORKING");
  return peer.runTurn(prompt);
};

/** Graceful stop: abort the in-flight turn, dispose, exit 0. */
const stop = async (): Promise<void> => {
  setStatus("STOPPED");
  await peer.abort().catch(() => {});
  peer.dispose();
  process.exit(0);
};

const reportDone = (result: SessionResult): void => {
  setStatus("DONE", result.usage ? String(result.usage.cost) : undefined, result.usage ? String(result.usage.tokens) : undefined);
};

const inbound: InboundDeps = {
  agentId: cfg.agentId,
  runTurn: runPrompt,
  send,
  stop: () => void stop(),
  onDone: reportDone,
  onError: (e) => console.error(e),
  retry: { maxRetries: cfg.retryMaxRetries, pauseMs: cfg.retryPauseMs },
};

// JSONL frames can split across TCP chunks; JsonlFramer reassembles them so a
// partial line is never parsed (and silently dropped) as its own frame. The
// StringDecoder also buffers a multibyte UTF-8 char split across two chunks,
// which chunk.toString() alone would corrupt into U+FFFD.
const framer = new JsonlFramer();
const decoder = new StringDecoder("utf8");
socket.on("data", (chunk) => {
  for (const line of framer.push(decoder.write(chunk))) {
    if (!handleInboundLine(line, inbound)) return;
  }
});
