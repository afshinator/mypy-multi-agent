// fallow-ignore-file unused-file
/**
 * Headless peer process entry point: parses argv, connects to the bus socket,
 * registers, heartbeats, and serves WORK_ORDER/PROMPT over one persistent pi
 * session. Side-effect script with no exports (runs on import, exits 1 on a bad
 * bootstrap), so it is live glue rather than unit-tested. Streams raw assistant
 * text to stdout (the herdr pane text channel) and collapsed state/cost to the
 * pane via StatusAdapter; logs tool calls to tool-calls.jsonl beside the bus.
 */
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { JsonlFramer } from "../bus/jsonl-framer";
import type { A2AEnvelope } from "../contracts/a2a-schema";
import { HerdrCliClient } from "../herdr/herdr-client";
import { StatusAdapter } from "../herdr/status-adapter";
import { ConversationLog } from "../logging/conversation-log";
import type { Permissions } from "../pi/tool-permissions";
import { changeNotifier } from "./change-notifier";
import { type PeerConfig, toolsForPermissions } from "./peer-config";
import { handleInboundLine, type InboundDeps, type SessionResult } from "./peer-harness";
import { PeerSession } from "./peer-session";
import { permissionGate } from "./permission-gate";
import { formatProgressAge, progressBucket, turnDisplayState } from "./progress-age";
import { toolCallLogger } from "./tool-call-logger";
import { webTool } from "./web-tool";

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
const model =
  slash > 0 ? runtime.getModel(cfg.model.slice(0, slash), cfg.model.slice(slash + 1)) : undefined;
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

// Live turn-progress indicator. The peer stamps the instant of the last progress
// event and only redraws the pane title when the coarse age bucket changes, so a
// 1 s heartbeat never spawns a herdr process per second.
let lastProgressAt = Date.now();
let lastProgressBucket: number | undefined;
let lastDisplayState: string | undefined;

const setStatus = (
  state: string,
  cost?: string,
  tokens?: string,
  progress?: string,
  displayState?: string,
): void => {
  if (status && paneId)
    void status.setStatus(paneId, {
      id: cfg.agentId,
      state,
      displayState,
      cost,
      tokens,
      role: cfg.title,
      model: cfg.model,
      progress,
    });
};

/** While a turn is open, refresh WORKING with the current age only when the age
 * bucket advanced or the display state changed (WORKING↔STALLED), never every
 * heartbeat. `state` stays canonical; `displayState` only tints the title. */
const refreshProgress = (busy: boolean): void => {
  if (!busy) return;
  const age = Date.now() - lastProgressAt;
  const bucket = progressBucket(age);
  const displayState = turnDisplayState(age, cfg.stallTimeoutMs);
  if (bucket === lastProgressBucket && displayState === lastDisplayState) return;
  lastProgressBucket = bucket;
  lastDisplayState = displayState;
  setStatus("WORKING", undefined, undefined, formatProgressAge(age), displayState);
};

socket.on("connect", () => {
  setStatus("STARTING");
  socket.write(
    `${JSON.stringify({
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
    })}\n`,
  );
});

// Fixed 1s heartbeat; this interval is also what keeps the process alive, so it
// must be released (via exit on close) or the peer orphans after the bus dies.
setInterval(() => {
  if (!socket.destroyed) {
    // A5: report whether a turn is open and whether it progressed since the last
    // beat, so the runtime can flag a live-but-stalled turn. RT-10: also carry the
    // retry in flight, so a transient provider error is visible on the bus.
    const { busy, progressed, retry } = peer.progressSnapshot();
    // A5: the heartbeat consumes the progress flag; the indicator stamps the
    // instant here, so the age resets on every progress event.
    if (progressed) lastProgressAt = Date.now();
    refreshProgress(busy);
    socket.write(
      `${JSON.stringify({
        id: `hb-${cfg.agentId}-${Date.now()}`,
        timestamp: Date.now(),
        sender: cfg.agentId,
        recipient: "supervisor",
        type: "HEARTBEAT",
        payload: { agentId: cfg.agentId, busy, progressed, ...(retry ? { retry } : {}) },
      })}\n`,
    );
  }
}, 1000);

const send = (env: A2AEnvelope): void => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(env)}\n`);
};

// One persistent session per peer, reused across all turns until the ask ends.
const peer = new PeerSession({
  createSession: async () => {
    const loader = new DefaultResourceLoader({
      cwd: cfg.workspaceRoot,
      agentDir: getAgentDir(),
      systemPromptOverride: () => cfg.systemPrompt,
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        permissionGate(permissions),
        toolCallLogger(cfg.agentId, toolLog),
        changeNotifier(cfg.agentId, send),
        webTool(),
      ],
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
  lastProgressAt = Date.now();
  lastProgressBucket = progressBucket(0);
  lastDisplayState = "WORKING";
  setStatus("WORKING", undefined, undefined, formatProgressAge(0));
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
  setStatus(
    "DONE",
    result.usage ? String(result.usage.cost) : undefined,
    result.usage ? String(result.usage.tokens) : undefined,
  );
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
