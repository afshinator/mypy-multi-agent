/**
 * Composition layer plus the socket dispatch core: wires the bus and the runtime
 * modules into one startable runtime, owns connection bookkeeping and envelope
 * fan-out, and is the only place protocol arms are switched on. Created and
 * driven by src/pi/extension.ts.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { FinalWriter } from "../artifacts/final-writer";
import { BudgetEnforcer } from "../budget/budget-enforcer";
import { PiUsageAdapter } from "../budget/pi-usage-adapter";
import { UsageAccounting } from "../budget/usage-accounting";
import { JsonlFramer } from "../bus/jsonl-framer";
import { MalformedCounter } from "../bus/malformed-counter";
import { routeFrame } from "../bus/router";
import { BusSocketServer } from "../bus/socket-server";
import type { A2AEnvelope } from "../contracts/a2a-schema";
import type { CriterionVerdict } from "../contracts/criteria";
import type { SessionConfig } from "../contracts/session-schema";
import { abortSession } from "../control/abort";
import { ControlPlane, type WorkOrder } from "../control/control-plane";
import { SessionState } from "../control/session-state";
import type { HerdrClient } from "../herdr/herdr-client";
import { PaneManager } from "../herdr/pane-manager";
import {
  type InjectionEstimate,
  type InjectionGateDecision,
  type InjectionGateLogEntry,
  screenInboundFrame,
} from "../jev/injection-gate";
import type { VerdictAdvisory } from "../jev/verdict-advisory";
import { FileLockManager } from "../locks/file-lock-manager";
import { ConversationLog } from "../logging/conversation-log";
import { toPeerConfig } from "../peer/peer-config";
import {
  finalize as buildFinalization,
  type CostBreakdown,
  criteriaSatisfied,
  type FinalSummary,
} from "../supervisor/finalization";
import { Reconciliation } from "../supervisor/reconciliation";
import { collectReports } from "../supervisor/report-collector";
import { Supervisor } from "../supervisor/supervisor";
import { ChangeDetector } from "../validation/change-detector";
import { checkRunContract } from "../validation/run-contract";
import {
  runValidation,
  type ValidationResult,
  validationAllowsSuccess,
} from "../validation/validation-runner";
import { AgentRegistry } from "./agent-registry";
import { CorrelationRegistry } from "./correlation-registry";
import type { ExitCode } from "./exit";
import { HeartbeatMonitor } from "./heartbeat-monitor";
import { PeerMessaging } from "./peer-messaging";
import type { AgentState } from "./state-machine";

export interface RuntimeOptions {
  now?: () => number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  isFreeModel?: (model: string) => boolean;
  execValidation?: (command: string) => Promise<boolean>;
  abortGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** C2 injection-gate classifier seam; the extension wires the live Jev model. */
  injectionEstimate?: InjectionEstimate;
  /** Absolute path to the peer harness entry (peer-main.ts). Defaults to cwd-relative. */
  peerScript?: string;
}

const defaultExecValidation = (command: string) =>
  new Promise<boolean>((resolve) => execFile("sh", ["-c", command], (err) => resolve(!err)));

// Inbound types whose payload.agentId names the acting peer (not a PROMPT
// target); a payload/sender mismatch means a peer forged another agent's id.
const SELF_ACTING = new Set([
  "HEARTBEAT",
  "FINAL_REPORT",
  "AGENT_UNUSABLE",
  "RESPONSE",
  "INTENT_TO_MODIFY",
  "LOCK_REQUEST",
  "LOCK_RELEASED",
]);

/**
 * Proven by an integration test (real socket, mock peer); peer spawning via
 * herdr is live wiring (spawnPeers), not unit-tested.
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
  private startedAt = 0;
  private readonly usageAdapter: PiUsageAdapter;
  /** RT-2: distinguishes an unpriced model (cost unknown) from a verified free one. */
  private readonly isFreeModel: (model: string) => boolean;
  private readonly heartbeats: HeartbeatMonitor;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;
  private readonly conversation: ConversationLog;
  private readonly execValidation: (command: string) => Promise<boolean>;
  private readonly abortGraceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly injectionEstimate: InjectionEstimate | undefined;
  private readonly peerScript?: string;
  private pendingLogs: Promise<void>[] = [];
  private readonly peerMessaging: PeerMessaging;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private sockets = new Map<string, Socket>(); // agentId -> socket
  /** MT-3: agents over the stop threshold, waiting for their work order to finish. */
  private readonly pendingStop = new Set<string>();
  /** A5: last progress time (runtime clock) per agent with an open turn, and the
   * set already flagged stalled this episode. */
  private readonly turnProgress = new Map<string, number>();
  private readonly stalled = new Set<string>();
  /** Latest reviewer attestation (RESPONSE.criteria) — the finalize gate trusts this, not the supervisor. */
  private peerCriteria: CriterionVerdict[] | undefined;
  /** The verdict block the finalize gate will use; read by the extension to run
   * the optional semantic advisory. */
  get attestedCriteria(): CriterionVerdict[] | undefined {
    return this.peerCriteria;
  }
  private connSeq = 0;
  /** A8: per-connection dispatch chain — frame N+1 is not dispatched until
   * frame N's gate promise settles, so a slow classifier cannot reorder a
   * connection (arrival order is preserved). shortcut: one settled tail is
   * retained per open connection that never closes; add idle eviction if the
   * bus gains half-open connections.
   */
  private dispatchChains = new Map<string, Promise<void>>();
  /** B1: the highest `at` handed to the gate log so far; append-time ordering. */
  private lastGateLogAt = 0;
  /** B1: one writer for the gate log, so appends happen in `at` order. */
  private gateLogChain: Promise<void> = Promise.resolve();

  private readonly askDir: string;
  private readonly runDetailsDir: string;
  private readonly workspaceRoot: string;

  constructor(
    askDir: string,
    herdr: HerdrClient,
    private readonly config: SessionConfig,
    opts: RuntimeOptions = {},
  ) {
    this.askDir = askDir;
    this.runDetailsDir = join(askDir, "run-details");
    this.workspaceRoot = resolve(config.session.workspace_root ?? process.cwd());
    this.now = opts.now ?? Date.now;
    this.heartbeats = new HeartbeatMonitor(opts.heartbeatTimeoutMs ?? 3000);
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 1000;
    this.bus = new BusSocketServer(this.runDetailsDir);
    this.controlPlane = new ControlPlane(
      this.session,
      { emit: (env) => this.emit(env) },
      (agentId) => this.markStopped(agentId),
    );
    this.peerMessaging = new PeerMessaging(
      this.correlations,
      (env) => this.emit(env),
      this.session,
      this.states,
    );
    this.supervisor = new Supervisor({
      controlPlane: this.controlPlane,
      shouldStopOnFault: () => true,
    });
    this.paneManager = new PaneManager(herdr);
    this.budget = new BudgetEnforcer(this.accounting, {
      agents: config.agents.map((a) => ({
        agentId: a.id,
        maxCostUsd: a.max_cost_usd,
        maxTokens: a.max_tokens,
      })),
      sessionMaxCostUsd: config.session.max_cost_usd,
      thresholdPercent: config.session.agent_stop_threshold_percent,
    });
    this.isFreeModel = opts.isFreeModel ?? (() => false);
    // The third arg is the usage-gap log sink; keep it wired so the adapter's
    // "priced call with no usage numbers" diagnostics are not silently dropped.
    this.usageAdapter = new PiUsageAdapter(this.accounting, this.isFreeModel, (entry) =>
      this.logEntry({ ...entry, type: "ERROR", timestamp: this.now() }),
    );
    this.conversation = new ConversationLog(join(this.runDetailsDir, "conversation.jsonl"));
    this.execValidation = opts.execValidation ?? defaultExecValidation;
    this.abortGraceMs = opts.abortGraceMs ?? 10_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.injectionEstimate = opts.injectionEstimate;
    this.peerScript = opts.peerScript;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    await mkdir(this.runDetailsDir, { recursive: true });
    await this.bus.start((socket) => this.handleConnection(socket));
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), this.heartbeatIntervalMs);
  }

  /** Milliseconds since start(); 0 before start(). */
  elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /** Live wiring: write each peer's config and spawn it into a herdr pane. */
  async spawnPeers(): Promise<void> {
    await mkdir(this.runDetailsDir, { recursive: true });
    const agents = [];
    for (const agent of this.config.agents) {
      const cfgPath = await this.writePeerConfig(agent);
      agents.push({ agentId: agent.id, command: this.peerCommand(cfgPath) });
    }
    await this.paneManager.spawnAll(agents, this.askDir);
  }

  /** MT-2b: respawn one peer in its existing pane, optionally with a different model. */
  /** RT-4: the live bound and usage for one agent, so a restart is informed. */
  agentBudget(agentId: string): {
    costUsd: number;
    tokens: number;
    boundTokens?: number;
    atOrOverBound: boolean;
  } {
    const agent = this.config.agents.find((a) => a.id === agentId);
    const costUsd = this.accounting.getAgentCost(agentId);
    const tokens = this.accounting.getAgentBoundTokens(agentId);
    const boundTokens = agent?.max_tokens;
    const costPct = agent ? (costUsd / agent.max_cost_usd) * 100 : 0;
    const tokenPct = boundTokens ? (tokens / boundTokens) * 100 : 0;
    const threshold = this.config.session.agent_stop_threshold_percent;
    return {
      costUsd,
      tokens,
      boundTokens,
      atOrOverBound: costPct >= threshold || (boundTokens !== undefined && tokenPct >= threshold),
    };
  }

  async restartAgent(agentId: string, model?: string): Promise<boolean> {
    const agent = this.config.agents.find((a) => a.id === agentId);
    if (agent === undefined) return false;
    // RT-4: restart preserves UsageAccounting by design (spend is not forgiven),
    // so a peer restarted after a budget/token stop can immediately re-stop.
    // Record the exact bound and usage so the supervisor sees that before deciding.
    const budget = this.agentBudget(agentId);
    this.logEntry({
      event: "restart-agent",
      agentId,
      model: model ?? agent.model,
      costUsd: budget.costUsd,
      tokens: budget.tokens,
      boundTokens: budget.boundTokens,
      atOrOverBound: budget.atOrOverBound,
      timestamp: this.now(),
    });
    if (model !== undefined) agent.model = model;
    await mkdir(this.runDetailsDir, { recursive: true });
    const cfgPath = await this.writePeerConfig(agent);
    // Evict the old connection and release the agent id, or the fresh process's
    // AGENT_REGISTER is rejected as a duplicate.
    const connId = this.registry.connectionOf(agentId);
    if (connId !== undefined) this.registry.remove(connId);
    this.sockets.get(agentId)?.destroy();
    this.sockets.delete(agentId);
    // Release locks the old process held and fail its in-flight prompts, or a
    // restarted peer deadlocks on a file it still "holds" and send_prompt hangs.
    this.locks.releaseAll(agentId);
    this.peerMessaging.onStopped(agentId);
    this.clearTurn(agentId);
    // Reset liveness so the fresh process starts clean, and drop any deferred stop.
    this.states.set(agentId, "PENDING");
    this.heartbeats.forget(agentId);
    this.peerMessaging.clearPending(agentId);
    this.pendingStop.delete(agentId);
    await this.paneManager.respawn(agentId, this.peerCommand(cfgPath));
    return true;
  }

  private async writePeerConfig(agent: SessionConfig["agents"][number]): Promise<string> {
    const cfgPath = join(this.runDetailsDir, `.peer-${agent.id}.json`);
    await writeFile(
      cfgPath,
      JSON.stringify(
        toPeerConfig(agent, this.bus.path, this.workspaceRoot, {
          pauseMs: this.config.session.peer_retry_pause_ms,
          maxRetries: this.config.session.peer_max_retries,
        }),
      ),
    );
    return cfgPath;
  }

  private peerCommand(cfgPath: string): string {
    const peerScript = this.peerScript ?? resolve(process.cwd(), "src/peer/peer-main.ts");
    return `bun ${peerScript} --config ${cfgPath}`;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    // Bus shutdown must run even if pane termination rejects, or the socket
    // server would leak with no live reference left to stop it.
    try {
      await this.paneManager.terminateAll();
    } finally {
      await this.bus.stop();
    }
  }

  /** Remove transient per-run files (peer configs). Explicit /finalize only, not abort. */
  async cleanup(): Promise<void> {
    for (const agent of this.config.agents) {
      await rm(join(this.runDetailsDir, `.peer-${agent.id}.json`), { force: true });
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
      finalWriter: new FinalWriter(this.runDetailsDir),
      graceMs: this.abortGraceMs,
      sleep: this.sleep,
    });
  }

  dispatch(agentId: string, workOrder: WorkOrder): boolean {
    const sent = this.controlPlane.dispatchWork(agentId, workOrder);
    // F1: a reply the peer buffered at the end of its PREVIOUS turn would otherwise
    // be handed to the next await as if it answered this work order.
    if (sent) this.peerMessaging.clearPending(agentId);
    return sent;
  }

  async sendPrompt(
    from: string,
    to: string,
    text: string,
    timeoutMs: number,
  ): Promise<A2AEnvelope> {
    try {
      return await this.peerMessaging.sendPrompt(from, to, text, timeoutMs);
    } catch (err) {
      const error = err as Error;
      this.logEntry({
        type: "ERROR",
        timestamp: this.now(),
        event: error.name === "PeerTerminalError" ? "peer-terminal" : "correlation-timeout",
        to,
        timeoutMs,
        message: error.message,
      });
      throw err;
    }
  }

  /** Block until an inbound message (PROMPT or RESPONSE) is addressed to `agentId`. */
  async awaitResponse(agentId: string, timeoutMs: number): Promise<A2AEnvelope> {
    try {
      return await this.peerMessaging.awaitResponse(agentId, timeoutMs);
    } catch (err) {
      const error = err as Error;
      this.logEntry({
        type: "ERROR",
        timestamp: this.now(),
        event: error.name === "PeerTerminalError" ? "peer-terminal" : "correlation-timeout",
        agentId,
        timeoutMs,
        message: error.message,
      });
      throw err;
    }
  }

  collectReports(): string {
    return collectReports(this.reconciliation);
  }

  /** Write final.md. Success = DoD AND peer-attested criteria AND (if code changed) validation AND run contract (see runSucceeded). */
  async finalize(
    dodSatisfied: boolean,
    supervisorUsage?: { costUsd: number; tokens: number },
    decision?: string,
    // Programmatic seam (tests / abort). Production never passes this: the
    // extension omits it, so the gate uses the peer-attested criteria below.
    criteria?: CriterionVerdict[],
    summary?: FinalSummary,
    advisory?: VerdictAdvisory,
  ): Promise<void> {
    if (!this.session.isFinalizing) this.session.enterFinalizing();
    this.session.complete();
    const validation = await runValidation(
      this.config.validation,
      this.changeDetector.hasChanged(),
      this.execValidation,
    );
    // "Done" = the supervisor asserts it AND every DoD criterion has a passing
    // verdict AND the mechanical validation passes.
    const attested = criteria ?? this.peerCriteria;
    const contract = checkRunContract(this.runDetailsDir);
    if (!contract.ok) {
      this.logEntry({
        type: "ERROR",
        timestamp: this.now(),
        event: "run-contract",
        missing: contract.missing,
      });
    }
    const success = this.runSucceeded(dodSatisfied, attested, validation, contract.ok);
    // buildFinalization is pure: building before logging lets the FINALIZED
    // entry and the final.md share one computed outcome instead of re-deriving it.
    const finalization = buildFinalization(
      this.reconciliation,
      success,
      decision,
      attested,
      summary,
      advisory,
    );
    this.logEntry({
      type: "FINALIZED",
      outcome: finalization.outcome,
      exitCode: finalization.exitCode,
      timestamp: this.now(),
    });
    await this.flush();
    await new FinalWriter(this.runDetailsDir).write({
      ...finalization,
      costs: this.costBreakdown(supervisorUsage),
    });
  }

  /** The ONE place where the run's success/failure decision lives. */
  private runSucceeded(
    dodSatisfied: boolean,
    attested: CriterionVerdict[] | undefined,
    validation: ValidationResult,
    contractOk: boolean,
  ): boolean {
    return (
      dodSatisfied &&
      criteriaSatisfied(attested, this.config.ask.definition_of_done) &&
      validationAllowsSuccess(validation) &&
      contractOk
    );
  }

  /** Aggregate cost/token totals for final.md from usage accounting. */
  private costBreakdown(supervisorUsage?: { costUsd: number; tokens: number }): CostBreakdown {
    const supervisorCostUsd = supervisorUsage?.costUsd ?? 0;
    const supervisorTokens = supervisorUsage?.tokens ?? 0;
    const agents = this.config.agents.map((a) => ({
      name: a.id,
      costUsd: this.accounting.getAgentCost(a.id),
      tokens: this.accounting.getAgentTokens(a.id),
    }));
    // RT-2: an unpriced model's dollar cost is a catalog estimate, not an invoice.
    const unpricedAgents = this.config.agents
      .filter((a) => this.isFreeModel(a.model))
      .map((a) => a.id);
    return {
      supervisorCostUsd,
      supervisorTokens,
      agents,
      unpricedAgents,
      totalCostUsd: supervisorCostUsd + agents.reduce((s, a) => s + a.costUsd, 0),
      totalTokens: supervisorTokens + agents.reduce((s, a) => s + a.tokens, 0),
    };
  }

  /** Await in-flight log writes so readers see a consistent file. */
  async flush(): Promise<void> {
    await Promise.all(this.pendingLogs);
    this.pendingLogs = [];
  }

  // HEARTBEAT fires 1/s/agent; logging it would flood conversation.jsonl.
  // Envelopes are logged on both directions (inbound via handleEnvelope, outbound
  // via emit), so one logical request can appear twice in the log.
  private log(env: A2AEnvelope): void {
    if (env.type === "HEARTBEAT") return;
    this.logEntry({
      timestamp: this.now(),
      type: env.type,
      id: env.id,
      sender: env.sender,
      recipient: env.recipient,
      payload: env.payload,
    });
  }

  private logEntry(entry: Record<string, unknown>): void {
    this.pendingLogs.push(this.conversation.append(entry));
  }

  private checkHeartbeats(): void {
    const now = this.now();
    for (const agentId of this.heartbeats.check(now)) {
      this.markCrashed(agentId, "heartbeat timeout");
    }
    this.checkStalls(now);
  }

  /** A5: flag an open turn that has reported no progress for stall_timeout_ms. */
  private checkStalls(now: number): void {
    const timeout = this.config.session.stall_timeout_ms;
    if (timeout <= 0) return;
    for (const [agentId, lastProgress] of this.turnProgress) {
      if (now - lastProgress >= timeout && !this.stalled.has(agentId)) {
        this.markStalled(agentId, now - lastProgress, now);
      }
    }
  }

  /** Notify-only: emit AGENT_STALLED and wake a waiting supervisor. The peer is
   * not stopped — a long tool can look stalled, and it may still reply. */
  private markStalled(agentId: string, elapsedMs: number, now: number): void {
    this.stalled.add(agentId);
    const env: A2AEnvelope = {
      id: `stall-${agentId}-${now}`,
      timestamp: now,
      sender: "bus",
      recipient: "supervisor",
      type: "AGENT_STALLED",
      payload: { agentId, reason: "no turn progress", elapsedMs },
    };
    this.emit(env);
    this.peerMessaging.onStalled(agentId, env);
  }

  /** A5: track turn progress from the heartbeat so a terminal/restarted peer is not scanned. */
  private handleHeartbeat(env: A2AEnvelope): void {
    const p = env.payload as { agentId: string; busy?: boolean; progressed?: boolean };
    this.heartbeats.beat(p.agentId, this.now());
    // A late beat from a terminal peer must not re-arm the stall scan (A5).
    const state = this.states.get(p.agentId);
    if (state === "STOPPED" || state === "CRASHED") return;
    if (p.busy) {
      // A first busy beat or an explicit progress tick refreshes the clock.
      if (p.progressed || !this.turnProgress.has(p.agentId)) {
        this.turnProgress.set(p.agentId, this.now());
        this.stalled.delete(p.agentId);
      }
    } else {
      this.clearTurn(p.agentId);
    }
  }

  private clearTurn(agentId: string): void {
    this.turnProgress.delete(agentId);
    this.stalled.delete(agentId);
  }

  private markCrashed(agentId: string, reason: string): void {
    const state = this.states.get(agentId);
    if (state === "CRASHED" || state === "STOPPED") return;
    this.states.set(agentId, "CRASHED");
    this.clearTurn(agentId);
    const env: A2AEnvelope = {
      id: `crash-${agentId}-${this.now()}`,
      timestamp: this.now(),
      sender: "bus",
      recipient: "supervisor",
      type: "AGENT_CRASHED",
      payload: { agentId, reason },
    };
    this.emit(env);
    this.peerMessaging.onCrash(agentId, env);
  }

  /** Mark an agent (or all) STOPPED on a stop signal so a clean exit is not logged as CRASHED. */
  private markStopped(agentId: string | "all"): void {
    const mark = (id: string) => {
      const state = this.states.get(id);
      if (state !== undefined && state !== "CRASHED") this.states.set(id, "STOPPED");
      this.clearTurn(id);
    };
    if (agentId === "all") {
      for (const id of this.registry.ids()) mark(id);
      this.correlations.failAll("session stopped");
    } else {
      mark(agentId);
      // Fails the peer's open await + any in-flight prompt (PeerMessaging owns
      // the `await:`/`prompt-N` correlation keys).
      this.peerMessaging.onStopped(agentId);
    }
  }

  private enforceBudget(): void {
    // Terminal agents are excluded so an already-stopped/crashed over-budget
    // agent neither re-signals nor masks the next active violation.
    const terminal = new Set(
      [...this.states].filter(([, s]) => s === "STOPPED" || s === "CRASHED").map(([id]) => id),
    );
    // Deferred (MT-3) agents are already recorded; skipping them here keeps the
    // first over-threshold agent from masking a later one.
    for (const id of this.pendingStop) terminal.add(id);
    const violation = this.budget.check(terminal);
    if (!violation) return;
    if (violation.kind === "agent") {
      // MT-3: defer the stop to the work-order boundary so the peer's task is
      // not truncated mid-flight; the stop is applied on its next FINAL_REPORT.
      if (this.config.session.stop_at_work_order_boundary) {
        this.pendingStop.add(violation.agentId);
        // The enforcer returns the first agent violation before the global
        // bound, so check the ceiling here or a deferred agent masks it.
        if (this.budget.globalExceeded() && this.session.isActive) {
          this.controlPlane.stopAll("global budget");
        }
        return;
      }
      this.controlPlane.stopAgent(violation.agentId, "budget threshold");
    } else if (this.session.isActive) this.controlPlane.stopAll("global budget");
  }

  /** MT-3: stop an over-threshold peer now that its work order has completed. */
  private applyBoundaryStop(agentId: string): void {
    if (this.pendingStop.delete(agentId)) this.controlPlane.stopAgent(agentId, "budget threshold");
  }

  private emit(env: A2AEnvelope): void {
    this.log(env);
    const line = `${JSON.stringify(env)}\n`;
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
        // Contain the flooder: stopAgent only signals, so the transport must be
        // closed here or a non-conforming peer keeps sending after being stopped.
        socket.destroy();
      },
    });
    socket.on("data", (chunk) => {
      for (const line of framer.push(chunk.toString())) {
        // A protocol fault earlier in this chunk may have destroyed the socket;
        // stop dispatching so we never write to a closed transport.
        if (socket.destroyed) break;
        const env = routeFrame(line, {
          sink: {
            fail: (correlationId, reason) => {
              if (correlationId !== undefined) this.correlations.fail(correlationId, reason);
            },
          },
          malformed: () => malformed.record(this.now()),
          sendError: (env) => this.emit(env),
          log: (entry) => this.logEntry({ ...entry, type: "ERROR", timestamp: this.now() }),
        });
        if (env !== undefined) {
          // A8: chain each frame onto the connection's previous dispatch so
          // frame N+1 is not dispatched before frame N's gate promise settles.
          // shortcut: the link has no rejection handler, so a rejecting
          // dispatchFrame would skip every later frame on this connection —
          // unreachable today (every await is inside its try and the catch body
          // is synchronous); add a handler if that stops being true.
          const prev = this.dispatchChains.get(connId) ?? Promise.resolve();
          this.dispatchChains.set(
            connId,
            prev.then(() => this.dispatchFrame(env, connId, socket)),
          );
        }
      }
    });
    // A peer that dies or is contained by the protocol-fault breaker is not a
    // runtime failure; without this listener the destroyed-socket write errors.
    socket.on("error", () => {});
    socket.on("close", () => {
      // R1: frames already queued behind the gate still have to be dispatched, so
      // the teardown waits for this connection's chain to settle — otherwise
      // handleEnvelope would judge them against a removed conn→agent binding and
      // drop an honest report as a sender mismatch.
      const finalize = () => {
        // O(1) lookup vs scanning sockets; the connectionId is already in scope.
        // remove() also drops the conn→agent binding so a reconnect can re-register.
        const agentId = this.registry.agentOf(connId);
        this.registry.remove(connId);
        // A8: drop the dispatch chain so a reconnect cannot inherit a stale one.
        this.dispatchChains.delete(connId);
        if (agentId !== undefined) {
          this.sockets.delete(agentId);
          this.locks.releaseAll(agentId);
          const state = this.states.get(agentId);
          if (this.session.isActive && state !== "DONE" && state !== "STOPPED") {
            this.markCrashed(agentId, "disconnected");
          }
        }
      };
      // Once, on either settle — a chain cannot reject today, but a crashed
      // teardown would strand the connection's state; `then` on both arms costs
      // nothing and cannot leak an unhandled rejection.
      void (this.dispatchChains.get(connId) ?? Promise.resolve()).then(finalize, finalize);
    });
  }

  /**
   * A8–A11: one inbound frame, serialized behind the connection's previous
   * dispatch. Screens the frame (annotation only — logged, never dropped,
   * never re-routed) when the gate is on, then dispatches the identical
   * envelope unconditionally: a peer that disconnects mid-gate still gets its
   * frame handled, because the connection's teardown waits for this chain.
   */
  private async dispatchFrame(env: A2AEnvelope, connId: string, socket: Socket): Promise<void> {
    try {
      const jev = this.config.session.jev;
      if (jev?.injection_check === true && this.injectionEstimate !== undefined) {
        const result = await screenInboundFrame(
          env,
          {
            model: jev.model,
            injection_threshold: jev.injection_threshold,
            injection_timeout_ms: jev.injection_timeout_ms,
          },
          { estimate: this.injectionEstimate, now: this.now },
        );
        if (result !== null) this.appendGateLog(result);
      }
      this.handleEnvelope(env, connId, socket);
    } catch (err) {
      // An arm that throws (e.g. duplicate AGENT_REGISTER) must not crash
      // the pi process hosting the runtime; contain it like a protocol fault.
      this.logEntry({
        type: "ERROR",
        timestamp: this.now(),
        event: "envelope-handler-threw",
        message: (err as Error).message,
      });
      socket.destroy();
    }
  }

  /**
   * B1/B3: append the §9 log entry and the §5 decision record in `at` order.
   * `at` is assigned here, at append time, and only ever increases, so file order
   * is `at` order across connections and §8's tie-breaks cannot be reached.
   */
  private appendGateLog(result: {
    decision: InjectionGateDecision;
    logEntry: InjectionGateLogEntry;
  }): void {
    const at = Math.max(this.now(), this.lastGateLogAt + 1);
    this.lastGateLogAt = at;
    this.gateLogChain = this.gateLogChain.then(async () => {
      // Key order stays the §9 declaration order: `at` is updated in place, not re-inserted.
      const entry: Record<string, unknown> = { ...result.logEntry };
      entry.at = at;
      await this.conversation.append(entry);
      // The supervisor-readable channel for §5 — the wire envelope is untouched.
      await this.conversation.append({
        type: "INJECTION_GATE_DECISION",
        timestamp: at,
        decision: result.decision,
      });
    });
    // shortcut: an append failure rejects the chain and skips later gate entries; add a
    // per-link catch if the log sink can fail transiently.
    this.pendingLogs.push(this.gateLogChain);
  }

  // fallow-ignore-next-line complexity
  private handleEnvelope(env: A2AEnvelope, connId: string, socket: Socket): void {
    this.log(env);
    // Sender-spoof guard: after AGENT_REGISTER maps a connection to an agent,
    // every inbound frame must come from that agent's connection, and (for
    // self-acting types) its payload.agentId must match, or a peer could forge
    // another agent's id and hijack its pending awaits. The registration arm
    // validates sender==agentId before mapping.
    if (env.type !== "AGENT_REGISTER") {
      const payloadAgentId = (env.payload as { agentId?: unknown }).agentId;
      const senderOk = this.registry.verifySender(connId, env.sender);
      const payloadOk = !SELF_ACTING.has(env.type) || payloadAgentId === env.sender;
      if (!senderOk || !payloadOk) {
        this.logEntry({
          type: "ERROR",
          timestamp: this.now(),
          event: "sender-mismatch",
          connId,
          sender: env.sender,
        });
        socket.destroy();
        return;
      }
    }
    // No `default` case: routeFrame validates envelope types upstream, so only
    // known A2A message types reach this dispatcher.
    switch (env.type) {
      case "AGENT_REGISTER":
        this.handleAgentRegister(env, connId, socket);
        break;
      case "HEARTBEAT":
        this.handleHeartbeat(env);
        break;
      case "AGENT_UNUSABLE":
        this.handleUnusable(env);
        break;
      case "FINAL_REPORT":
        this.handleFinalReport(env);
        break;
      case "RESPONSE":
        this.handleResponse(env);
        break;
      case "ACK":
        this.handleAck(env);
        break;
      case "PROMPT":
        this.peerMessaging.onPrompt(env);
        break;
      case "INTENT_TO_MODIFY":
        this.changeDetector.markChanged();
        break;
      case "LOCK_REQUEST":
        this.acquireLock(env.payload as { agentId: string; filePath: string; lockId: string });
        break;
      case "LOCK_RELEASED":
        this.handleLockReleased(env);
        break;
    }
  }

  private handleAgentRegister(env: A2AEnvelope, connId: string, socket: Socket): void {
    const agentId = (env.payload as { agentId: string }).agentId;
    // A peer may only register itself (payload + sender agree) and must be a
    // configured agent; otherwise one connection could claim another agent's
    // id before its real peer connects.
    const configured = this.config.agents.some((a) => a.id === agentId);
    if (agentId !== env.sender || !configured) {
      this.logEntry({
        type: "ERROR",
        timestamp: this.now(),
        event: "sender-mismatch",
        connId,
        sender: env.sender,
      });
      socket.destroy();
      return;
    }
    this.registry.register(connId, agentId);
    this.sockets.set(agentId, socket);
    this.states.set(agentId, "PENDING");
    // Drop stale liveness/crash state from a prior connection so a respawned
    // peer starts clean (no phantom heartbeat timeout or old AGENT_CRASHED).
    this.heartbeats.forget(agentId);
    this.peerMessaging.clearPending(agentId);
  }

  private handleFinalReport(env: A2AEnvelope): void {
    // A report also unblocks any pending awaitResponse waiter, not just the
    // reconciliation collector.
    this.reconciliation.captureFinalReport(env);
    this.peerMessaging.onResponse(env);
    const agentId = (env.payload as { agentId: string }).agentId;
    const criteria = (env.payload as { criteria?: CriterionVerdict[] }).criteria;
    if (criteria !== undefined) this.captureCriteria(agentId, criteria);
    this.states.set(agentId, "DONE");
    this.recordAgentUsage(
      agentId,
      (env.payload as { usage?: { cost: number; tokens: number; cacheReadTokens?: number } }).usage,
    );
    this.enforceBudget();
    // A completed work order is the MT-3 boundary: apply any deferred stop now.
    this.applyBoundaryStop(agentId);
  }

  /** MT-2: a peer that stayed connected but only ever produced empty, zero-usage
   * turns. Mark it terminal, wake any waiting supervisor await, and stop it. */
  private handleUnusable(env: A2AEnvelope): void {
    const { agentId, reason } = env.payload as { agentId: string; reason: string };
    const state = this.states.get(agentId);
    if (state === "STOPPED" || state === "CRASHED") return;
    this.states.set(agentId, "CRASHED");
    this.pendingStop.delete(agentId);
    this.clearTurn(agentId);
    this.peerMessaging.onResponse(env);
    this.controlPlane.stopAgent(agentId, reason);
  }

  /**
   * Capture a peer's verdict block, but only from the designated attester and
   * only when non-empty. Shared by the RESPONSE (prompt reply) and FINAL_REPORT
   * (work-order report) paths so either delivery satisfies the gate
   * (RT-8 R10, RT-9 G1/G2).
   */
  private captureCriteria(agentId: string, criteria: CriterionVerdict[]): void {
    if (criteria.length === 0) return;
    const attester = this.config.session.attester;
    if (agentId !== attester) {
      this.logEntry({
        type: "ERROR",
        timestamp: this.now(),
        event: "non-attester-verdict",
        agentId,
        attester,
      });
      return;
    }
    this.peerCriteria = criteria;
  }

  private handleResponse(env: A2AEnvelope): void {
    const agentId = (env.payload as { agentId: string }).agentId;
    const criteria = (env.payload as { criteria?: CriterionVerdict[] }).criteria;
    // A later RESPONSE must not clear an earlier attestation: dropping the
    // guard would silently void the reviewer criteria the finalize gate reads.
    if (criteria !== undefined) this.captureCriteria(agentId, criteria);
    this.recordAgentUsage(
      agentId,
      (env.payload as { usage?: { cost: number; tokens: number; cacheReadTokens?: number } }).usage,
    );
    this.peerMessaging.onResponse(env);
    this.enforceBudget();
  }

  private handleAck(env: A2AEnvelope): void {
    if (env.correlationId !== undefined) this.correlations.resolve(env.correlationId, env);
  }

  private handleLockReleased(env: A2AEnvelope): void {
    const p = env.payload as { agentId: string; filePath: string };
    this.locks.release(p.agentId, p.filePath);
  }

  /** Resolve the sender's configured model and record its usage; shared by the
   * FINAL_REPORT and RESPONSE arms, whose lookup + record lines are identical. */
  private recordAgentUsage(
    agentId: string,
    usage?: { cost: number; tokens: number; cacheReadTokens?: number },
  ): void {
    const model = this.config.agents.find((a) => a.id === agentId)?.model ?? "";
    this.usageAdapter.record({
      agentId,
      model,
      cost: usage?.cost,
      tokens: usage?.tokens,
      cacheReadTokens: usage?.cacheReadTokens,
    });
  }

  /**
   * The one async envelope handler: emit LOCK_ACQUIRED on grant; any rejection
   * (denial or timeout) is swallowed and the requester simply sees no ACK.
   */
  private acquireLock(p: { agentId: string; filePath: string; lockId: string }): void {
    this.locks
      .acquire(p.agentId, p.filePath, 30_000)
      .then(() => {
        this.emit({
          id: `lock-${p.lockId}`,
          timestamp: this.now(),
          sender: "bus",
          recipient: p.agentId,
          type: "LOCK_ACQUIRED",
          payload: { agentId: p.agentId, filePath: p.filePath, lockId: p.lockId },
        });
      })
      .catch(() => {});
  }
}
