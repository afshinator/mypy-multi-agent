// fallow-ignore-file unused-file
/**
 * Headless peer process entry point: parses argv, connects to the bus socket,
 * registers, heartbeats, and serves WORK_ORDER/PROMPT over one persistent pi
 * session. Side-effect script with no exports (runs on import, exits 1 on a bad
 * bootstrap), so it is live glue rather than unit-tested. Streams raw assistant
 * text to stdout (the herdr pane text channel) and collapsed state/cost to the
 * pane via StatusAdapter; logs tool calls to tool-calls.jsonl in the run's
 * run-details dir.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { JsonlFramer } from "../bus/jsonl-framer";
import { connectPeer, endpointFromBusPath, parsePeerEndpoint } from "../bus/peer-link";
import type { A2AEnvelope } from "../contracts/a2a-schema";
import { HerdrCliClient } from "../herdr/herdr-client";
import { StatusAdapter } from "../herdr/status-adapter";
import { ConversationLog } from "../logging/conversation-log";
import type { Permissions } from "../pi/tool-permissions";
import { PeerTraceState } from "../tracing/peer-trace";
import { FieldsTracer } from "../tracing/tracing";
import { changeNotifier } from "./change-notifier";
import { FileLock, fileLock } from "./file-lock";
import { type PeerConfig, peerToolLogPath, toolsForPermissions } from "./peer-config";
import { handleInboundLine, type InboundDeps, type SessionResult } from "./peer-harness";
import { PeerSession } from "./peer-session";
import { permissionGate } from "./permission-gate";
import { writePeerStatus } from "./status-writer";
import { toolCallLogger } from "./tool-call-logger";
import { TurnIndicator, type TurnIndicatorView } from "./turn-indicator";
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

// The descriptor is the seam: a peer with no descriptor dials its run's bus path.
const endpoint =
  cfg.endpoint === undefined ? endpointFromBusPath(cfg.busPath) : parsePeerEndpoint(cfg.endpoint);
const socket = connectPeer(endpoint);
// The tool log's path comes from the run dir, not the socket: a long run path
// moves the socket into the OS temp dir, shared by every run on the machine.
const toolLog = new ConversationLog(peerToolLogPath(cfg));
const spanLog = new ConversationLog(join(cfg.runDetailsDir, "spans.jsonl"));
const tracer = new FieldsTracer({
  sink: (record) =>
    void spanLog.append(record as unknown as Record<string, unknown>).catch(() => {}),
});
const peerTrace = new PeerTraceState(tracer);
const permissions: Permissions = { ...cfg.permissions, shellAllowlist: cfg.shellAllowlist };

const paneId = process.env.HERDR_PANE_ID;
const status = paneId ? new StatusAdapter(new HerdrCliClient(), "peer") : undefined;

// Live turn-progress indicator. The indicator owns the last-progress instant,
// the coarse age bucket, and the display state; the peer only publishes the
// view it returns, so a 1 s heartbeat never spawns a herdr process per second.
const indicator = new TurnIndicator(Date.now());

const setStatus = (
  state: string,
  cost?: string,
  tokens?: string,
  progress?: string,
  displayState?: string,
): void => {
  if (status && paneId)
    writePeerStatus(status, paneId, cfg, state, cost, tokens, progress, displayState);
};

const publishTurnView = (view: TurnIndicatorView): void => {
  setStatus(view.state, undefined, undefined, view.progress, view.displayState);
};

socket.onConnect(() => {
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
    const now = Date.now();
    indicator.observe(progressed, now);
    const view = indicator.view(busy, now, cfg.stallTimeoutMs);
    if (view) publishTurnView(view);
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

// Cross-process file lock (issue #40): asked around every edit/write.
const locks = new FileLock(cfg.agentId, send, undefined, (p) => resolve(cfg.workspaceRoot, p));

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
        toolCallLogger(cfg.agentId, toolLog, peerTrace),
        changeNotifier(cfg.agentId, send),
        fileLock(locks),
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
socket.onClose(() => {
  peer.dispose();
  process.exit(0);
});
socket.onError((err) => {
  console.error(`bus socket error: ${err.message}`);
  process.exit(1);
});

const runPrompt = (prompt: string): Promise<SessionResult> => {
  const now = Date.now();
  indicator.reset(now);
  const view = indicator.view(true, now, cfg.stallTimeoutMs);
  if (view) publishTurnView(view);
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
  trace: peerTrace,
  onLockFrame: (env) => locks.onFrame(env),
  onError: (e) => {
    console.error(e);
    // A failed turn must not leave STALLED on the pane (spec F5): reset the
    // clock and republish the canonical WORKING label with no age.
    indicator.reset(Date.now());
    setStatus("WORKING");
  },
  retry: { maxRetries: cfg.retryMaxRetries, pauseMs: cfg.retryPauseMs },
};

// JSONL frames can split across chunks; JsonlFramer reassembles them so a
// partial line is never parsed (and silently dropped) as its own frame. The
// connection already decoded UTF-8 with a per-connection StringDecoder, so a
// multibyte char split across chunks is not corrupted.
const framer = new JsonlFramer();
socket.onData((chunk) => {
  for (const line of framer.push(chunk)) {
    if (!handleInboundLine(line, inbound)) return;
  }
});
