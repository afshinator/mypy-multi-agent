import type { Socket } from "node:net";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BusSocketServer } from "../bus/socket-server";
import { JsonlFramer } from "../bus/jsonl-framer";
import { routeFrame } from "../bus/router";
import { MalformedCounter } from "../bus/malformed-counter";
import { AgentRegistry } from "./agent-registry";
import { HeartbeatMonitor } from "./heartbeat-monitor";
import { CorrelationRegistry } from "./correlation-registry";
import { PeerMessaging } from "./peer-messaging";
import { UsageAccounting } from "../budget/usage-accounting";
import { BudgetEnforcer } from "../budget/budget-enforcer";
import { PiUsageAdapter } from "../budget/pi-usage-adapter";
import { FileLockManager } from "../locks/file-lock-manager";
import type { WorkOrder } from "./work-order-manager";
import type { AgentState } from "./state-machine";
import { SessionState } from "../control/session-state";
import { ControlPlane } from "../control/control-plane";
import { Reconciliation } from "../supervisor/reconciliation";
import { Supervisor } from "../supervisor/supervisor";
import { collectReports } from "../supervisor/report-collector";
import { finalize as buildFinalization } from "../supervisor/finalization";
import { abortSession } from "../control/abort";
import { EXIT, type ExitCode } from "./exit";
import { FinalWriter } from "../artifacts/final-writer";
import { ConversationLog } from "../logging/conversation-log";
import { ChangeDetector } from "../validation/change-detector";
import { runValidation, validationAllowsSuccess } from "../validation/validation-runner";
import { PaneManager } from "../herdr/pane-manager";
import type { HerdrClient } from "../herdr/herdr-client";
import { toPeerConfig } from "../peer/peer-config";
import type { SessionConfig } from "../contracts/session-schema";
import type { A2AEnvelope } from "../contracts/a2a-schema";

export interface RuntimeOptions {
  now?: () => number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  isFreeModel?: (model: string) => boolean;
  execValidation?: (command: string) => Promise<boolean>;
  abortGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Absolute path to the peer harness entry (peer-main.ts). Defaults to cwd-relative. */
  peerScript?: string;
}

const defaultExecValidation = (command: string) =>
  new Promise<boolean>((resolve) => execFile("sh", ["-c", command], (err) => resolve(!err)));

/**
 * Composition layer: wires the bus + all L1-L9 runtime modules into one
 * startable runtime. Proven by an integration test (real socket, mock peer);
 * peer spawning via herdr is live wiring (spawnPeers), not unit-tested.
 */
export class Runtime {
  readonly session = new SessionState();
  readonly registry = new AgentRegistry();
  readonly correlations = new CorrelationRegistry();
  readonly reconciliation = new Reconciliation();
  readonly states = new Map<string, AgentState>();
  readonly accounting = new UsageAccounting();
  readonly locks = new FileLockManager();
  readonly changeDetector = new ChangeDetector();
  readonly controlPlane: ControlPlane;
  readonly supervisor: Supervisor;
  readonly paneManager: PaneManager;
  readonly bus: BusSocketServer;

  private readonly budget: BudgetEnforcer;
  private readonly usageAdapter: PiUsageAdapter;
  private readonly heartbeats: HeartbeatMonitor;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;
  private readonly conversation: ConversationLog;
  private readonly execValidation: (command: string) => Promise<boolean>;
  private readonly abortGraceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly peerScript?: string;
  private pendingLogs: Promise<void>[] = [];
  private readonly peerMessaging: PeerMessaging;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private sockets = new Map<string, Socket>(); // agentId -> socket
  private connSeq = 0;

  private readonly askDir: string;

  constructor(
    askDir: string,
    herdr: HerdrClient,
    private readonly config: SessionConfig,
    opts: RuntimeOptions = {},
  ) {
    this.askDir = askDir;
    this.now = opts.now ?? Date.now;
    this.heartbeats = new HeartbeatMonitor(opts.heartbeatTimeoutMs ?? 3000);
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 1000;
    this.bus = new BusSocketServer(askDir);
    this.controlPlane = new ControlPlane(this.session, { emit: (env) => this.emit(env) });
    this.peerMessaging = new PeerMessaging(this.correlations, (env) => this.emit(env), this.session, this.states);
    this.supervisor = new Supervisor({
      controlPlane: this.controlPlane,
      reconciliation: this.reconciliation,
      shouldStopOnFault: () => true,
    });
    this.paneManager = new PaneManager(herdr);
    this.budget = new BudgetEnforcer(this.accounting, {
      agents: config.agents.map((a) => ({ agentId: a.id, maxCostUsd: a.max_cost_usd, maxTokens: a.max_tokens })),
      sessionMaxCostUsd: config.session.max_cost_usd,
      thresholdPercent: config.session.agent_stop_threshold_percent,
    });
    this.usageAdapter = new PiUsageAdapter(this.accounting, opts.isFreeModel ?? (() => false), () => {});
    this.conversation = new ConversationLog(join(askDir, "conversation.jsonl"));
    this.execValidation = opts.execValidation ?? defaultExecValidation;
    this.abortGraceMs = opts.abortGraceMs ?? 10_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.peerScript = opts.peerScript;
  }

  async start(): Promise<void> {
    await this.bus.start((socket) => this.handleConnection(socket));
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), this.heartbeatIntervalMs);
  }

  /** Live wiring: write each peer's config and spawn it into a herdr pane. */
  async spawnPeers(): Promise<void> {
    const peerScript = this.peerScript ?? resolve(process.cwd(), "src/peer/peer-main.ts");
    const agents = [];
    for (const agent of this.config.agents) {
      const cfgPath = join(this.askDir, `.peer-${agent.id}.json`);
      await writeFile(cfgPath, JSON.stringify(toPeerConfig(agent, this.bus.path)));
      agents.push({ agentId: agent.id, command: `bun ${peerScript} --config ${cfgPath}` });
    }
    await this.paneManager.spawnAll(agents, this.askDir);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await this.paneManager.terminateAll();
    await this.bus.stop();
  }

  /** Remove transient per-run files (peer configs). Explicit /finalize only, not abort. */
  async cleanup(): Promise<void> {
    for (const agent of this.config.agents) {
      await rm(join(this.askDir, `.peer-${agent.id}.json`), { force: true });
    }
  }

  /** User abort: graceful stop, grace, force-kill, teardown, aborted final.md, exit 2. */
  async abort(): Promise<ExitCode> {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    return abortSession({
      controlPlane: this.controlPlane,
      paneManager: this.paneManager,
      bus: this.bus,
      finalWriter: new FinalWriter(this.askDir),
      graceMs: this.abortGraceMs,
      sleep: this.sleep,
    });
  }

  dispatch(agentId: string, workOrder: WorkOrder): boolean {
    return this.controlPlane.dispatchWork(agentId, workOrder);
  }

  sendPrompt(from: string, to: string, text: string, timeoutMs: number) {
    return this.peerMessaging.sendPrompt(from, to, text, timeoutMs);
  }

  /** Block until an inbound message (PROMPT or RESPONSE) is addressed to `agentId`. */
  awaitResponse(agentId: string, timeoutMs: number) {
    return this.peerMessaging.awaitResponse(agentId, timeoutMs);
  }

  collectReports(): string {
    return collectReports(this.reconciliation);
  }

  /** Write final.md. Success = DoD AND (if code changed) configured validation passing. */
  async finalize(dodSatisfied: boolean, supervisorUsage?: { costUsd: number; tokens: number }): Promise<void> {
    if (!this.session.isFinalizing) this.session.enterFinalizing();
    this.session.complete();
    const validation = await runValidation(this.config.validation, this.changeDetector.hasChanged(), this.execValidation);
    const success = dodSatisfied && validationAllowsSuccess(validation);
    this.logEntry({ type: "FINALIZED", outcome: success ? "success" : "failure", exitCode: success ? EXIT.SUCCESS : EXIT.FAILURE, timestamp: this.now() });
    await this.flush();
    const finalization = buildFinalization(this.reconciliation, success);
    const supervisorCostUsd = supervisorUsage?.costUsd ?? 0;
    const supervisorTokens = supervisorUsage?.tokens ?? 0;
    const agents = this.config.agents.map((a) => ({
      name: a.id,
      costUsd: this.accounting.getAgentCost(a.id),
      tokens: this.accounting.getAgentTokens(a.id),
    }));
    const peerCost = agents.reduce((s, a) => s + a.costUsd, 0);
    const peerTokens = agents.reduce((s, a) => s + a.tokens, 0);
    await new FinalWriter(this.askDir).write({
      ...finalization,
      costs: {
        supervisorCostUsd,
        supervisorTokens,
        agents,
        totalCostUsd: supervisorCostUsd + peerCost,
        totalTokens: supervisorTokens + peerTokens,
      },
    });
  }

  /** Await in-flight log writes so readers see a consistent file. */
  async flush(): Promise<void> {
    await Promise.all(this.pendingLogs);
    this.pendingLogs = [];
  }

  private log(env: A2AEnvelope): void {
    if (env.type === "HEARTBEAT") return;
    this.logEntry({ type: env.type, id: env.id, sender: env.sender, recipient: env.recipient, payload: env.payload });
  }

  private logEntry(entry: Record<string, unknown>): void {
    this.pendingLogs.push(this.conversation.append(entry));
  }

  private checkHeartbeats(): void {
    for (const agentId of this.heartbeats.check(this.now())) {
      this.markCrashed(agentId, "heartbeat timeout");
    }
  }

  private markCrashed(agentId: string, reason: string): void {
    if (this.states.get(agentId) === "CRASHED") return;
    this.states.set(agentId, "CRASHED");
    this.emit({
      id: `crash-${agentId}-${this.now()}`,
      timestamp: this.now(),
      sender: "bus",
      recipient: "supervisor",
      type: "AGENT_CRASHED",
      payload: { agentId, reason },
    });
  }

  private enforceBudget(): void {
    const violation = this.budget.check();
    if (!violation) return;
    if (violation.kind === "agent") this.controlPlane.stopAgent(violation.agentId, "budget threshold");
    else this.controlPlane.stopAll("global budget");
  }

  private emit(env: A2AEnvelope): void {
    this.log(env);
    const line = JSON.stringify(env) + "\n";
    if (env.recipient === "all") {
      for (const s of this.sockets.values()) s.write(line);
    } else {
      this.sockets.get(env.recipient)?.write(line);
    }
  }

  private handleConnection(socket: Socket): void {
    const connId = `conn-${++this.connSeq}`;
    const framer = new JsonlFramer();
    const malformed = new MalformedCounter(5, 60_000, {
      onProtocolFault: () => {
        const agentId = this.registry.agentOf(connId) ?? "unknown";
        this.supervisor.onProtocolFault(agentId, 5);
      },
    });
    socket.on("data", (chunk) => {
      for (const line of framer.push(chunk.toString())) {
        const result = routeFrame(line, {
          sink: { fail: (correlationId, reason) => { if (correlationId !== undefined) this.correlations.fail(correlationId, reason); } },
          malformed: () => malformed.record(this.now()),
          sendError: (env) => this.emit(env),
          log: () => {},
        });
        if (result === "valid") this.handleEnvelope(JSON.parse(line) as A2AEnvelope, connId, socket);
      }
    });
    socket.on("close", () => {
      const agentId = [...this.sockets.entries()].find(([, s]) => s === socket)?.[0];
      if (agentId !== undefined) {
        this.sockets.delete(agentId);
        this.locks.releaseAll(agentId);
        const state = this.states.get(agentId);
        if (this.session.isActive && state !== "DONE" && state !== "STOPPED") {
          this.markCrashed(agentId, "disconnected");
        }
      }
    });
  }

  private handleEnvelope(env: A2AEnvelope, connId: string, socket: Socket): void {
    this.log(env);
    switch (env.type) {
      case "AGENT_REGISTER": {
        const agentId = (env.payload as { agentId: string }).agentId;
        this.registry.register(connId, agentId);
        this.sockets.set(agentId, socket);
        this.states.set(agentId, "PENDING");
        break;
      }
      case "HEARTBEAT": {
        const agentId = (env.payload as { agentId: string }).agentId;
        this.heartbeats.beat(agentId, this.now());
        break;
      }
      case "FINAL_REPORT": {
        this.reconciliation.captureFinalReport(env);
        const agentId = (env.payload as { agentId: string }).agentId;
        this.states.set(agentId, "DONE");
        const usage = (env.payload as { usage?: { cost: number; tokens: number } }).usage;
        const model = this.config.agents.find((a) => a.id === agentId)?.model ?? "";
        this.usageAdapter.record({ agentId, model, cost: usage?.cost, tokens: usage?.tokens });
        this.enforceBudget();
        break;
      }
      case "RESPONSE": {
        this.peerMessaging.onResponse(env);
        break;
      }
      case "ACK": {
        if (env.correlationId !== undefined) this.correlations.resolve(env.correlationId, env);
        break;
      }
      case "PROMPT": {
        this.peerMessaging.onPrompt(env);
        break;
      }
      case "INTENT_TO_MODIFY": {
        this.changeDetector.markChanged();
        break;
      }
      case "LOCK_REQUEST": {
        const p = env.payload as { agentId: string; filePath: string; lockId: string };
        this.locks.acquire(p.agentId, p.filePath, 30_000).then(() => {
          this.emit({
            id: `lock-${p.lockId}`,
            timestamp: this.now(),
            sender: "bus",
            recipient: p.agentId,
            type: "LOCK_ACQUIRED",
            payload: { agentId: p.agentId, filePath: p.filePath, lockId: p.lockId },
          });
        }).catch(() => {});
        break;
      }
      case "LOCK_RELEASED": {
        const p = env.payload as { agentId: string; filePath: string };
        this.locks.release(p.agentId, p.filePath);
        break;
      }
    }
  }
}
