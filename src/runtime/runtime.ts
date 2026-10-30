/**
 * Composition layer plus the socket dispatch core: wires the bus and the runtime
 * modules into one startable runtime, owns connection bookkeeping and envelope
 * fan-out, and is the only place protocol arms are switched on. Created and
 * driven by src/pi/extension.ts.
 */

import { execFileSync, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FinalWriter } from "../artifacts/final-writer";
import { BudgetEnforcer } from "../budget/budget-enforcer";
import { PiUsageAdapter } from "../budget/pi-usage-adapter";
import { UsageAccounting } from "../budget/usage-accounting";
import { JsonlFramer } from "../bus/jsonl-framer";
import { MalformedCounter } from "../bus/malformed-counter";
import { type PeerConnection, type PeerLink, UnixSocketLink } from "../bus/peer-link";
import { routeFrame } from "../bus/router";
import { BusSocketServer } from "../bus/socket-server";
import type { A2AEnvelope } from "../contracts/a2a-schema";
import type { CriterionVerdict } from "../contracts/criteria";
import type { SessionConfig } from "../contracts/session-schema";
import { abortSession } from "../control/abort";
import { ControlPlane, type WorkOrder } from "../control/control-plane";
import { SessionState } from "../control/session-state";
import type { HerdrClient } from "../herdr/herdr-client";
import {
  type InjectionEstimate,
  type InjectionGateDecision,
  type InjectionGateLogEntry,
  screenInboundFrame,
} from "../jev/injection-gate";
import type { VerdictAdvisory } from "../jev/verdict-advisory";
import { FileLockManager } from "../locks/file-lock-manager";
import { ConversationLog, readJsonl } from "../logging/conversation-log";
import { stallTimeoutForAgent, toPeerConfig } from "../peer/peer-config";
import { HerdrPeerLauncher, type PeerLauncher, type PeerSpec } from "../peer/peer-launcher";
import { appendLedgerLine, sanitizeScorecard } from "../scorecard/collector";
import { recordScorecard } from "../scorecard/record";
import {
  finalize as buildFinalization,
  type CostBreakdown,
  criteriaMismatches,
  criteriaSatisfied,
  type FinalSummary,
  type GateResult,
  gateResultFromTerms,
  staleCitations,
  toolReadTimes,
} from "../supervisor/finalization";
import { Reconciliation } from "../supervisor/reconciliation";
import { collectReports } from "../supervisor/report-collector";
import { Supervisor } from "../supervisor/supervisor";
import { FieldsTracer, type SpanHandle } from "../tracing/tracing";
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
import {
  FIRST_TOOL_CALL_PROBE_WINDOW_MS,
  firstToolCallProbe,
  writerRoleNeedsProbe,
  writerRoleProbeEligible,
} from "./first-tool-call-probe";
import { HeartbeatMonitor } from "./heartbeat-monitor";
import { PeerMessaging } from "./peer-messaging";
import { type PeerStatus, peerStatus } from "./peer-status";
import { buildRunState, type RunStateV1, writeRunState } from "./run-state";
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
  /** Raw session.yaml text, used to hash the snapshot's config identity. */
  sessionYaml?: string;
}

/**
 * Validation commands run with the session's finalization bound: a command that
 * never exits must fail the gate, not hang finalize forever. `0` disables the bound.
 *
 * The shell leads its own process group, and a timeout kills the whole group.
 * Node's `timeout` on execFile signals only the direct child, so a compound
 * command's children outlived the run and kept writing into the tree after
 * finalize had declared failure (issue #42). Output is discarded: the gate reads
 * the exit code, and buffering a suite's stdout only costs memory.
 */
const defaultExecValidation =
  (timeoutMs: number) =>
  (command: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const child = spawn("sh", ["-c", command], { detached: true, stdio: "ignore" });
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (child.pid !== undefined) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  // The group is already gone.
                }
              }
              resolve(false);
            }, timeoutMs)
          : undefined;
      child.on("error", () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(false);
      });
      child.on("exit", (code) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(code === 0);
      });
    });
  };

/**
 * Issue #134: the cheap elicitation sent to an unproven slug before a writer
 * role is assigned. The reply is not the verdict — the first tool call is.
 */
const WRITER_PROBE_PROMPT =
  "Liveness probe before a writer role: make one read-only tool call (read, grep, ls, or an allowlisted command) and reply with a single line. This is a probe, not the work order.";

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

// Issue #133: lock frames are protocol plumbing, not conversation; log() sends
// them to lock-frames.jsonl so conversation.jsonl stays a report of the work.
const LOCK_FRAME_TYPES = new Set([
  "LOCK_REQUEST",
  "LOCK_ACQUIRED",
  "LOCK_RELEASED",
  "LOCK_REFUSED",
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
  readonly launcher: PeerLauncher;
  readonly bus: BusSocketServer;

  private readonly budget: BudgetEnforcer;
  private startedAt = 0;
  /** Run start for supervisor cost accounting; null until start, restored on resume. */
  private accountingBoundaryMs: number | null = null;
  /** The last snapshot write. Snapshot writes are chained so an older one can
   * never land after a newer one and restore stale totals. */
  private snapshotWrite: Promise<void> = Promise.resolve();
  private readonly usageAdapter: PiUsageAdapter;
  /** RT-2: distinguishes an unpriced model (cost unknown) from a verified free one. */
  private readonly isFreeModel: (model: string) => boolean;
  private readonly heartbeats: HeartbeatMonitor;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;
  private readonly conversation: ConversationLog;
  /** Issue #133: lock frames leave the conversation log for this side artifact. */
  private readonly lockLog: ConversationLog;
  private readonly spanLog: ConversationLog;
  /** S6: the fields-only tracer; spans are additive (run-details/spans.jsonl). */
  readonly tracer: FieldsTracer;
  private readonly execValidation: (command: string) => Promise<boolean>;
  private readonly abortGraceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly injectionEstimate: InjectionEstimate | undefined;
  private readonly peerScript?: string;
  private readonly sessionYaml: string;
  /** In-flight log appends, pruned as each settles (issue #36). */
  private readonly pendingLogs = new Set<Promise<void>>();
  private readonly peerMessaging: PeerMessaging;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** Reachability seam (#99): agentId -> connection, behind a transport-neutral link. */
  private readonly link: PeerLink;
  /** MT-3: agents over the stop threshold, waiting for their work order to finish. */
  private readonly pendingStop = new Set<string>();
  /** A5: last progress time (runtime clock) per agent with an open turn, and the
   * set already flagged stalled this episode. */
  private readonly turnProgress = new Map<string, number>();
  /** Last heartbeat that reported an explicit progress tick (a tool started or
   * finished). Distinct from `turnProgress`, which also stamps a first busy beat:
   * the probe needs tool activity, not merely being busy. */
  private readonly lastProgressTick = new Map<string, number>();
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
  /** O2: when the attester's verdict block was captured; 0 = none (so no staleness). */
  private criteriaAttestedAt = 0;
  /** RT-10: the retry attempt last logged per agent, so each change logs once. */
  private readonly lastRetry = new Map<string, string | undefined>();
  /** D2: the taskId most recently completed per agent, captured at FINAL_REPORT. */
  private readonly lastCompletedWorkOrder = new Map<string, string>();
  /** D2: the in-flight taskId per agent, captured at dispatch. */
  private readonly inFlightTaskIds = new Map<string, string>();
  /** S6: taskId -> dispatch span handle (net-new; inFlightTaskIds stores taskId only). */
  private readonly dispatchSpans = new Map<string, SpanHandle>();
  /** S6: the run span minted once at start(); also the sender's ambient span. */
  private runSpan: SpanHandle | null = null;

  private readonly askDir: string;
  private readonly runDetailsDir: string;
  private readonly workspaceRoot: string;
  /** HEAD when this runtime was constructed: the base an aggregate diff needs. */
  private readonly baseCommit: string | undefined;

  constructor(
    askDir: string,
    herdr: HerdrClient,
    private readonly config: SessionConfig,
    opts: RuntimeOptions = {},
  ) {
    this.askDir = askDir;
    this.runDetailsDir = join(askDir, "run-details");
    this.workspaceRoot = resolve(config.session.workspace_root ?? process.cwd());
    this.baseCommit = Runtime.readBaseCommit(this.workspaceRoot);
    this.now = opts.now ?? Date.now;
    this.heartbeats = new HeartbeatMonitor(opts.heartbeatTimeoutMs ?? 3000);
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 1000;
    this.bus = new BusSocketServer(this.runDetailsDir);
    this.link = new UnixSocketLink(this.bus);
    this.spanLog = new ConversationLog(join(this.runDetailsDir, "spans.jsonl"));
    this.tracer = new FieldsTracer({
      now: this.now,
      sink: (record) =>
        void this.spanLog.append(record as unknown as Record<string, unknown>).catch(() => {}),
    });
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
      { tracer: this.tracer, currentSpan: () => this.runSpan },
    );
    this.supervisor = new Supervisor({
      controlPlane: this.controlPlane,
      shouldStopOnFault: () => true,
    });
    this.launcher = new HerdrPeerLauncher(herdr);
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
    this.lockLog = new ConversationLog(join(this.runDetailsDir, "lock-frames.jsonl"));
    this.execValidation =
      opts.execValidation ?? defaultExecValidation(config.session.finalization_grace_ms);
    this.abortGraceMs = opts.abortGraceMs ?? 10_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.injectionEstimate = opts.injectionEstimate;
    this.peerScript = opts.peerScript;
    this.sessionYaml = opts.sessionYaml ?? "";
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    // A fresh run opens the accounting window here; resume has already restored
    // the original window, so a restored boundary is left untouched.
    if (this.accountingBoundaryMs === null) this.accountingBoundaryMs = Date.now();
    await mkdir(this.runDetailsDir, { recursive: true });
    if (this.runSpan === null) {
      this.runSpan = this.tracer.startSpan("run", {
        parent: null,
        kind: "run-level",
        scopeId: null,
        agentId: null,
      });
    }
    await this.link.start((connection) => this.handleConnection(connection));
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), this.heartbeatIntervalMs);
  }

  /** Milliseconds since start(); 0 before start(). */
  elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /** Epoch ms of the run's accounting boundary; 0 = count the whole session. */
  accountingStartedAtMs(): number {
    return this.accountingBoundaryMs ?? 0;
  }

  /** D4: explicit resume path. Rehydrates state first, then starts the bus and
   * re-spawns peers. `start()` itself never reads the snapshot. */
  async resume(state: RunStateV1): Promise<void> {
    this.rehydrate(state);
    await this.start();
    await this.spawnPeers();
  }

  private rehydrate(state: RunStateV1): void {
    // Pre-#35 snapshots carry no accounting boundary; counting the whole session
    // as this run's cost would double-count earlier runs, so refuse the resume
    // rather than silently presenting whole-session totals as this run's cost.
    if (state.startedAtMs === undefined) {
      throw new Error(
        "refusing to resume a legacy run-state snapshot without startedAtMs: " +
          "it has no accounting boundary, so this run would report the whole pi " +
          "session's cost as its own; start a new run instead",
      );
    }
    this.accountingBoundaryMs = state.startedAtMs;
    this.accounting.restore(
      state.agents.map((a) => ({
        agentId: a.id,
        cost: a.usage.costUsd,
        tokens: a.usage.tokens,
        cacheReadTokens: a.usage.cacheReadTokens,
      })),
    );
    for (const a of state.agents) {
      this.states.set(a.id, a.state);
      if (a.lastCompletedWorkOrder !== null)
        this.lastCompletedWorkOrder.set(a.id, a.lastCompletedWorkOrder);
      if (a.inFlightTaskId !== null) this.inFlightTaskIds.set(a.id, a.inFlightTaskId);
    }
  }

  /** Live wiring: write each peer's config and hand the launcher its command line. */
  async spawnPeers(): Promise<void> {
    await mkdir(this.runDetailsDir, { recursive: true });
    const peers: PeerSpec[] = [];
    for (const agent of this.config.agents) {
      const cfgPath = await this.writePeerConfig(agent);
      peers.push({ agentId: agent.id, command: this.peerCommand(cfgPath) });
    }
    await this.launcher.launchAll(peers, this.askDir);
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
    this.link.destroy(agentId);
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
    await this.launcher.respawn(agentId, this.peerCommand(cfgPath));
    return true;
  }

  private async writePeerConfig(agent: SessionConfig["agents"][number]): Promise<string> {
    const cfgPath = join(this.runDetailsDir, `.peer-${agent.id}.json`);
    const policy = {
      pauseMs: this.config.session.peer_retry_pause_ms,
      maxRetries: this.config.session.peer_max_retries,
      // Issue #134: the deadline this peer's class runs under — the free-class
      // value for a free slug, the session value otherwise. The same helper
      // drives checkStalls, so the label the peer shows and the runtime's
      // AGENT_STALLED timing cannot diverge.
      stallTimeoutMs: stallTimeoutForAgent(agent, this.config.session, this.isFreeModel),
      // Issue #133: the lock acquire bound travels to the peer like the stall
      // deadline, so both sides time the same race (peer waits bound + margin).
      lockAcquireTimeoutMs: this.config.session.lock_acquire_timeout_ms,
    };
    await writeFile(
      cfgPath,
      JSON.stringify(
        toPeerConfig(agent, this.bus.path, this.workspaceRoot, policy, this.runDetailsDir),
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
      await this.launcher.terminateAll();
    } finally {
      await this.link.stop();
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
    // A user abort closes every open supervisor span with status 'aborted'.
    for (const span of this.dispatchSpans.values()) this.tracer.endSpan(span, "aborted");
    this.dispatchSpans.clear();
    if (this.runSpan !== null) {
      this.tracer.endSpan(this.runSpan, "aborted");
      this.runSpan = null;
    }
    this.peerMessaging.abortOpenSpans();
    return abortSession({
      controlPlane: this.controlPlane,
      launcher: this.launcher,
      bus: this.bus,
      finalWriter: new FinalWriter(this.runDetailsDir),
      graceMs: this.abortGraceMs,
      sleep: this.sleep,
    });
  }

  dispatch(agentId: string, workOrder: WorkOrder): boolean {
    // emit drops a frame for a peer with no live connection, so claiming success
    // would leave the supervisor waiting out a full await_response timeout for
    // work that never left the bus.
    if (!this.link.has(agentId)) return false;
    if (!this.session.acceptsNewWork()) return false;
    // Issue #134: a writer role to a free-class slug is held for the
    // first-tool-call probe when the slug has never produced a tool call.
    // `true` means accepted: the order reaches the peer the moment the slug
    // proves it can act, and is reported unproven otherwise. Priced slugs and
    // scope-less orders dispatch unchanged.
    const agent = this.config.agents.find((a) => a.id === agentId);
    if (
      agent !== undefined &&
      writerRoleProbeEligible(
        { model: agent.model, edit: agent.permissions.edit },
        workOrder,
        this.isFreeModel,
      )
    ) {
      void this.maybeProbeThenDispatch(agentId, agent, workOrder);
      return true;
    }
    return this.dispatchNow(agentId, workOrder);
  }

  /** The actual dispatch: span, envelope, bookkeeping. Shared by the direct
   * path and the post-probe path, so a probed order reaches the peer
   * identically to an unprobed one. */
  private dispatchNow(agentId: string, workOrder: WorkOrder): boolean {
    if (!this.link.has(agentId)) return false;
    if (!this.session.acceptsNewWork()) return false;
    const span = this.tracer.startSpan("dispatch", {
      parent: this.runSpan,
      kind: "work-order-level",
      scopeId: workOrder.taskId,
      agentId: null,
      operationId: workOrder.taskId,
    });
    const carrier: Record<string, unknown> = {};
    this.tracer.inject(carrier, span);
    const sent = this.controlPlane.dispatchWork(agentId, workOrder, carrier.traceparent as string);
    // F1: a reply the peer buffered at the end of its PREVIOUS turn would otherwise
    // be handed to the next await as if it answered this work order.
    if (sent) {
      this.dispatchSpans.set(workOrder.taskId, span);
      this.peerMessaging.clearPending(agentId);
      this.inFlightTaskIds.set(agentId, workOrder.taskId);
      void this.writeRunStateSnapshot();
    } else {
      this.tracer.endSpan(span, "error");
    }
    return sent;
  }

  /**
   * Issue #134: hold a writer-role work order until the slug has produced a
   * tool call. An already-proven slug dispatches immediately; an unproven one
   * gets a cheap elicitation prompt and up to FIRST_TOOL_CALL_PROBE_WINDOW_MS
   * to act. The verdict is tool-call activity (tool-calls.jsonl), never a
   * reply, so a live but silent peer is never written off and a mute slug is
   * never handed the role. Notify-only on failure: nothing is stopped.
   */
  private async maybeProbeThenDispatch(
    agentId: string,
    agent: SessionConfig["agents"][number],
    workOrder: WorkOrder,
  ): Promise<void> {
    const candidate = { model: agent.model, edit: agent.permissions.edit };
    const observed = await this.observedToolCalls(agentId);
    if (!writerRoleNeedsProbe(candidate, workOrder, observed, this.isFreeModel)) {
      this.dispatchNow(agentId, workOrder);
      return;
    }
    const windowMs = FIRST_TOOL_CALL_PROBE_WINDOW_MS;
    const startedAt = this.now();
    this.logEntry({
      timestamp: this.now(),
      event: "writer-probe-started",
      agentId,
      taskId: workOrder.taskId,
      windowMs,
    });
    let replied = false;
    // Elicitation: the reply is not the verdict — the first tool call is — but
    // a live slug answers the cheap prompt while a mute one produces nothing.
    void this.peerMessaging.sendPrompt("supervisor", agentId, WRITER_PROBE_PROMPT, windowMs).then(
      () => {
        replied = true;
      },
      () => {},
    );
    for (;;) {
      const verdict = firstToolCallProbe({
        toolCalls: await this.observedToolCalls(agentId),
        // A tool that started is activity even before it finishes: the same
        // signal the stall detector trusts, so a slow first call cannot bench a
        // live slug.
        progressed: (this.lastProgressTick.get(agentId) ?? 0) >= startedAt,
        replied,
        elapsedMs: this.now() - startedAt,
        windowMs,
      });
      if (verdict.action === "proceed") {
        if (!this.dispatchNow(agentId, workOrder)) {
          this.logEntry({
            type: "ERROR",
            timestamp: this.now(),
            event: "writer-probe-dispatch-failed",
            agentId,
            taskId: workOrder.taskId,
          });
        }
        return;
      }
      if (verdict.action === "unproven") {
        this.reportSlugUnproven(agentId, windowMs, workOrder.taskId);
        return;
      }
      await this.sleep(1000);
    }
  }

  /**
   * Issue #134: notify the supervisor that a slug stayed unproven for a writer
   * role. Notify-only, like AGENT_STALLED: the peer is not stopped. Delivered
   * as a text report rather than an AGENT_STALLED envelope, so the supervisor
   * reads what actually happened — the order was never dispatched — instead of
   * "no turn progress", the misreading this change exists to prevent.
   */
  private reportSlugUnproven(agentId: string, windowMs: number, taskId: string): void {
    const env: A2AEnvelope = {
      id: `probe-${agentId}-${this.now()}`,
      timestamp: this.now(),
      sender: "bus",
      recipient: "supervisor",
      type: "RESPONSE",
      payload: {
        agentId,
        text: `writer probe: ${agentId} produced no tool call within ${windowMs}ms — slug unproven; work order ${taskId} was NOT dispatched. Reassign the writer role or probe again.`,
      },
    };
    this.emit(env);
    // Buffer under `await:<agentId>` (the AGENT_STALLED delivery path) so a
    // waiting or later await_response surfaces the report.
    this.peerMessaging.onStalled(agentId, env);
  }

  /** Issue #134: completed tool calls observed for one agent, from the shared
   * tool-calls.jsonl the peers already write. The probe's only evidence. */
  private async observedToolCalls(agentId: string): Promise<number> {
    const entries = await readJsonl(join(this.runDetailsDir, "tool-calls.jsonl"));
    return entries.filter((e) => e.agentId === agentId).length;
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

  async collectReports(): Promise<string> {
    return collectReports(this.reconciliation, join(this.runDetailsDir, "reports"));
  }

  /** Write final.md. Success = DoD AND peer-attested criteria AND (if code changed) validation AND run contract (see gateResult). */
  async finalize(
    dodSatisfied: boolean,
    supervisorUsage?: { costUsd: number; tokens: number },
    decision?: string,
    // Programmatic seam (tests / abort). Production never passes this: the
    // extension omits it, so the gate uses the peer-attested criteria below.
    criteria?: CriterionVerdict[],
    summary?: FinalSummary,
    advisory?: VerdictAdvisory,
  ): Promise<GateResult> {
    const finalizeSpan = this.tracer.startSpan("finalize", {
      parent: this.runSpan,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    try {
      return await this.runFinalize(
        dodSatisfied,
        supervisorUsage,
        decision,
        criteria,
        summary,
        advisory,
        finalizeSpan,
      );
    } finally {
      this.tracer.endSpan(finalizeSpan);
      if (this.runSpan) this.tracer.endSpan(this.runSpan);
    }
  }

  private async runFinalize(
    dodSatisfied: boolean,
    supervisorUsage: { costUsd: number; tokens: number } | undefined,
    decision: string | undefined,
    criteria: CriterionVerdict[] | undefined,
    summary: FinalSummary | undefined,
    advisory: VerdictAdvisory | undefined,
    finalizeSpan: SpanHandle,
  ): Promise<GateResult> {
    if (!this.session.isFinalizing) this.session.enterFinalizing();
    const validation = await runValidation(
      this.config.validation,
      this.changeDetector.hasChanged(),
      this.execValidation,
      { tracer: this.tracer, parent: finalizeSpan },
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
    // O2: a verdict describes the tree the reviewer read. If a file it cites changed
    // after the block was captured, the citation may describe a state that is gone —
    // reject it and let the supervisor re-ask, rather than certify a stale reading.
    const readTimes = await this.attesterReadTimes();
    const stale = staleCitations(
      attested ?? [],
      this.criteriaAttestedAt,
      (p) => this.citedMtime(p),
      (p) => {
        // The read is recorded as the peer resolved it; a citation may be written
        // differently, so fall back to the locator's own resolution.
        const direct = readTimes.get(resolve(this.workspaceRoot, p));
        if (direct !== undefined) return direct;
        const resolved = this.citePath(p);
        return resolved === undefined ? undefined : readTimes.get(resolved);
      },
    );
    if (stale.length > 0) {
      this.logEntry({
        type: "ERROR",
        timestamp: this.now(),
        event: "stale-attestation",
        files: stale.map((s) => s.path),
      });
    }
    const result = this.gateResult(
      dodSatisfied,
      attested,
      validation,
      contract.ok,
      stale.length === 0,
    );
    // A failed term must be named (issue #119): before this, dod/criteria/
    // validation rejected a run with no record of which term did it.
    for (const term of result.failingTerms) {
      this.logEntry({
        type: "ERROR",
        timestamp: this.now(),
        event: "gate-rejected",
        term: term.name,
        ...(term.name === "criteria"
          ? { mismatches: criteriaMismatches(attested, this.config.ask.definition_of_done) }
          : {}),
        ...(term.detail === undefined ? {} : { detail: term.detail }),
      });
    }
    // buildFinalization is pure: building before logging lets the FINALIZED
    // entry and the final.md share one computed outcome instead of re-deriving it.
    const finalization = buildFinalization(
      this.reconciliation,
      result.success,
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
    // Terminal only once the artifact exists: a failed write must stay retryable.
    this.session.complete();
    // Opt-in per-run health scorecard (issue #14). Additive only: it must not
    // change the outcome/exit code, and a failed write must not fail finalize.
    if (this.config.session.record_scorecard) {
      try {
        const scorecard = await recordScorecard(
          this.runDetailsDir,
          this.config,
          // The card's identity: the run's task directory relative to the
          // workspace root, so a ledger line can be traced and filtered.
          relative(this.workspaceRoot, this.askDir),
        );
        const sanitized = sanitizeScorecard(scorecard);
        if (sanitized !== null) {
          await appendLedgerLine(join(this.workspaceRoot, "quality", "ledger.jsonl"), sanitized);
        }
      } catch (err) {
        this.logEntry({
          type: "ERROR",
          timestamp: this.now(),
          event: "scorecard-write-failed",
          message: (err as Error).message,
        });
      }
    }
    await this.writeRunStateSnapshot(supervisorUsage);
    return result;
  }

  /** The ONE place where the run's success/failure decision lives. */
  private gateResult(
    dodSatisfied: boolean,
    attested: CriterionVerdict[] | undefined,
    validation: ValidationResult,
    contractOk: boolean,
    citationsFresh: boolean,
  ): GateResult {
    return gateResultFromTerms(
      dodSatisfied,
      criteriaSatisfied(attested, this.config.ask.definition_of_done),
      citationsFresh,
      validationAllowsSuccess(validation),
      validation.status === "failed" ? validation.command : undefined,
      contractOk,
    );
  }

  /** Resolve a cited path against the workspace, then the run dirs, and stat it (O2). */
  private citePath(path: string): string | undefined {
    const candidates = isAbsolute(path)
      ? [resolve(path)]
      : [
          resolve(this.workspaceRoot, path),
          resolve(this.runDetailsDir, path),
          resolve(this.askDir, path),
        ];
    for (const candidate of candidates) {
      try {
        statSync(candidate);
        return candidate;
      } catch {
        // Try the next base; an unresolvable locator is not this check's verdict.
      }
    }
    return undefined;
  }

  /** The mtime of a cited path, once it resolves (O2). */
  private citedMtime(path: string): number | undefined {
    const resolved = this.citePath(path);
    if (resolved === undefined) return undefined;
    try {
      return statSync(resolved).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /**
   * Issue #8: when the attester last read each path, from the peer-written
   * tool-call log. A file rewritten after that read but before the attestation
   * carries an mtime older than the attestation, so only the read time catches it.
   */
  private async attesterReadTimes(): Promise<Map<string, number>> {
    const entries = await readJsonl(join(this.runDetailsDir, "tool-calls.jsonl"));
    return toolReadTimes(entries, this.config.session.attester, (p) =>
      resolve(this.workspaceRoot, p),
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

  /** Await in-flight log writes so readers see a consistent file. Settled appends
   * are already pruned (see `track`), so this waits on what is still in flight;
   * a rejected append must not block finalize — the artifact is the product. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingLogs]);
    this.pendingLogs.clear();
  }

  // HEARTBEAT fires 1/s/agent; logging it would flood conversation.jsonl.
  // Envelopes are logged on both directions (inbound via handleEnvelope, outbound
  // via emit), so one logical request can appear twice in the log.
  private log(env: A2AEnvelope): void {
    if (env.type === "HEARTBEAT") return;
    const entry: Record<string, unknown> = {
      timestamp: this.now(),
      type: env.type,
      id: env.id,
      sender: env.sender,
      recipient: env.recipient,
      payload: env.payload,
    };
    // #21: persist the correlation id so the scorecard pairs turn opens/closes
    // by identity instead of timestamp position.
    if (env.correlationId !== undefined) entry.correlationId = env.correlationId;
    // Issue #133: lock frames leave conversation.jsonl for lock-frames.jsonl;
    // the artifact is a protocol trace, not evidence for the finalize gate.
    if (LOCK_FRAME_TYPES.has(env.type)) {
      this.track(this.lockLog.append(entry));
      return;
    }
    // FINAL_REPORT does not echo its taskId (the peer only sees `action`); the
    // runtime knows it from dispatch-time inFlightTaskIds, still intact here
    // because log runs before handleFinalReport consumes it.
    if (env.type === "FINAL_REPORT") {
      const agentId = (env.payload as { agentId: string }).agentId;
      const taskId = this.inFlightTaskIds.get(agentId);
      if (taskId !== undefined) entry.taskId = taskId;
    }
    this.logEntry(entry);
  }

  private logEntry(entry: Record<string, unknown>): void {
    this.track(this.conversation.append(entry));
  }

  /**
   * Track one append until it settles. The rejection handler is attached here, not
   * only in flush(): an unobserved rejected append is an unhandled rejection, and
   * bun exits 1 on those, so one failed log line would kill the run. Settled
   * promises are dropped so a long run does not retain every entry (issue #36).
   */
  private track(append: Promise<void>): void {
    this.pendingLogs.add(append);
    void append.then(
      () => this.pendingLogs.delete(append),
      () => this.pendingLogs.delete(append),
    );
  }

  /** HEAD at construction. A run must diff against a fixed commit: `main...HEAD`
   * is empty whenever the work lands on `main` (post-mortem-03 rec 6). */
  private static readBaseCommit(cwd: string): string | undefined {
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      return head === "" ? undefined : head;
    } catch {
      return undefined; // not a git checkout: the snapshot omits the field
    }
  }

  /** D2: write the snapshot at a work-order boundary. Fire-and-forget; a write
   * failure is logged and never crashes the run. At finalize the caller awaits
   * it, and passes the supervisor's usage so the run's own totals are complete
   * (post-mortem-03 rec 20: 8,108,464 tokens were missing from this file).
   *
   * Each write waits for the previous one. Without that ordering, the
   * fire-and-forget write from FINAL_REPORT can still be in flight when
   * finalize writes, and it would land last with the agents-only totals. */
  private writeRunStateSnapshot(supervisorUsage?: {
    costUsd: number;
    tokens: number;
  }): Promise<void> {
    const state = buildRunState({
      config: this.config,
      rawSessionYaml: this.sessionYaml,
      accounting: this.accounting,
      states: this.states,
      startedAtMs: this.accountingBoundaryMs ?? 0,
      baseCommit: this.baseCommit,
      supervisorUsage,
      lastCompletedWorkOrder: this.lastCompletedWorkOrder,
      inFlightTaskIds: this.inFlightTaskIds,
    });
    const write = this.snapshotWrite.then(async () => {
      try {
        await writeRunState(this.runDetailsDir, state);
      } catch (err) {
        this.logEntry({
          type: "ERROR",
          timestamp: this.now(),
          event: "run-state-write",
          message: (err as Error).message,
        });
      }
    });
    this.snapshotWrite = write;
    return write;
  }

  private checkHeartbeats(): void {
    const now = this.now();
    for (const agentId of this.heartbeats.check(now)) {
      this.markCrashed(agentId, "heartbeat timeout");
    }
    this.checkStalls(now);
  }

  /** A5 + #134: the stall deadline one agent runs under — the free-class value
   * for a free slug, the session value otherwise (0 disables for that agent). */
  private stallDeadlineMs(agentId: string): number {
    const agent = this.config.agents.find((a) => a.id === agentId);
    return agent === undefined
      ? this.config.session.stall_timeout_ms
      : stallTimeoutForAgent(agent, this.config.session, this.isFreeModel);
  }

  /** A5: flag an open turn that has reported no progress for its deadline. */
  private checkStalls(now: number): void {
    for (const [agentId, lastProgress] of this.turnProgress) {
      const timeout = this.stallDeadlineMs(agentId);
      if (timeout <= 0) continue;
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
    const p = env.payload as {
      agentId: string;
      busy?: boolean;
      progressed?: boolean;
      retry?: { attempt: number; maxAttempts: number };
    };
    this.heartbeats.beat(p.agentId, this.now());
    // RT-10: a retry is the only bus-visible trace of a transient provider error,
    // and heartbeats are not logged, so record the attempt on change. Heartbeats
    // fire 1/s, so logging every beat with a retry would flood the log.
    const retryKey = p.retry ? `${p.retry.attempt}/${p.retry.maxAttempts}` : undefined;
    if (retryKey !== this.lastRetry.get(p.agentId)) {
      this.lastRetry.set(p.agentId, retryKey);
      if (retryKey !== undefined) {
        this.logEntry({
          type: "RETRY",
          timestamp: this.now(),
          agentId: p.agentId,
          event: "peer-retry",
          attempt: p.retry?.attempt,
          maxAttempts: p.retry?.maxAttempts,
        });
      }
    }
    // A late beat from a terminal peer must not re-arm the stall scan (A5).
    const state = this.states.get(p.agentId);
    if (state === "STOPPED" || state === "CRASHED") return;
    if (p.busy) {
      // A first busy beat or an explicit progress tick refreshes the clock.
      if (p.progressed || !this.turnProgress.has(p.agentId)) {
        this.turnProgress.set(p.agentId, this.now());
        this.stalled.delete(p.agentId);
      }
      if (p.progressed) this.lastProgressTick.set(p.agentId, this.now());
    } else {
      this.clearTurn(p.agentId);
    }
  }

  private clearTurn(agentId: string): void {
    this.turnProgress.delete(agentId);
    this.lastProgressTick.delete(agentId);
    this.stalled.delete(agentId);
  }

  /**
   * Issue #4: each peer's live turn state, derived from in-memory heartbeat state.
   * A read-only view: it sends nothing to the peer, so the supervisor can stop
   * spending a full peer turn on a `ping` PROMPT just to learn a peer is busy.
   */
  peerStatuses(now = this.now()): PeerStatus[] {
    return this.config.agents.map((agent) =>
      peerStatus(
        agent.id,
        this.states.get(agent.id) ?? "UNKNOWN",
        this.turnProgress.get(agent.id),
        this.stalled.has(agent.id),
        now,
      ),
    );
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
      this.link.sendAll(line);
    } else {
      this.link.send(env.recipient, line);
    }
  }

  private handleConnection(connection: PeerConnection): void {
    const connId = `conn-${++this.connSeq}`;
    const framer = new JsonlFramer();
    const malformed = new MalformedCounter(5, 60_000, {
      onProtocolFault: () => {
        const agentId = this.registry.agentOf(connId) ?? "unknown";
        this.supervisor.onProtocolFault(agentId, 5);
        // Contain the flooder: stopAgent only signals, so the transport must be
        // closed here or a non-conforming peer keeps sending after being stopped.
        connection.destroy();
      },
    });
    connection.onData((chunk) => {
      for (const line of framer.push(chunk)) {
        // A protocol fault earlier in this chunk may have destroyed the socket;
        // stop dispatching so we never write to a closed transport.
        if (connection.destroyed) break;
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
            prev.then(() => this.dispatchFrame(env, connId, connection)),
          );
        }
      }
    });
    // A peer that dies or is contained by the protocol-fault breaker is not a
    // runtime failure; PeerConnection.onError exists so a destroyed-transport
    // write does not raise.
    connection.onError(() => {});
    connection.onClose(() => {
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
          this.link.unregister(agentId);
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
  private async dispatchFrame(
    env: A2AEnvelope,
    connId: string,
    connection: PeerConnection,
  ): Promise<void> {
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
      this.handleEnvelope(env, connId, connection);
    } catch (err) {
      // An arm that throws (e.g. duplicate AGENT_REGISTER) must not crash
      // the pi process hosting the runtime; contain it like a protocol fault.
      this.logEntry({
        type: "ERROR",
        timestamp: this.now(),
        event: "envelope-handler-threw",
        message: (err as Error).message,
      });
      connection.destroy();
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
    this.track(this.gateLogChain);
  }

  // fallow-ignore-next-line complexity
  private handleEnvelope(env: A2AEnvelope, connId: string, connection: PeerConnection): void {
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
        connection.destroy();
        return;
      }
    }
    // No `default` case: routeFrame validates envelope types upstream, so only
    // known A2A message types reach this dispatcher.
    switch (env.type) {
      case "AGENT_REGISTER":
        this.handleAgentRegister(env, connId, connection);
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

  private handleAgentRegister(env: A2AEnvelope, connId: string, connection: PeerConnection): void {
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
      connection.destroy();
      return;
    }
    this.registry.register(connId, agentId);
    this.link.register(agentId, connection);
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
    // D2: the in-flight task (recorded at dispatch) is now the last completed one.
    const taskId = this.inFlightTaskIds.get(agentId);
    const dispatchSpan = taskId !== undefined ? this.dispatchSpans.get(taskId) : undefined;
    if (taskId !== undefined && dispatchSpan) {
      const report = this.tracer.startSpan("final_report", {
        parent: dispatchSpan,
        kind: "work-order-level",
        scopeId: taskId,
        agentId: null,
        operationId: taskId,
      });
      this.tracer.endSpan(report);
    }
    if (dispatchSpan) this.tracer.endSpan(dispatchSpan);
    if (taskId !== undefined) this.dispatchSpans.delete(taskId);
    if (taskId !== undefined) {
      this.lastCompletedWorkOrder.set(agentId, taskId);
      this.inFlightTaskIds.delete(agentId);
    }
    void this.writeRunStateSnapshot();
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
    // O2: the instant this block was captured is what cited artifacts are compared
    // against at finalize. Only the attester's block sets it — a non-attester's
    // would move the clock forward and hide a rewrite that landed after the
    // block the gate actually trusts.
    this.criteriaAttestedAt = this.now();
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
   * The one async envelope handler: emit LOCK_ACQUIRED on grant; a rejection
   * (denial or timeout) is answered with a LOCK_REFUSED frame carrying the lock
   * id, so the peer's waiter settles at once instead of timing out on silence
   * and blaming a holder that may no longer exist (issue #133).
   */
  private acquireLock(p: { agentId: string; filePath: string; lockId: string }): void {
    this.locks
      .acquire(p.agentId, p.filePath, this.config.session.lock_acquire_timeout_ms)
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
      .catch(() => {
        this.emit({
          id: `lock-refused-${p.lockId}`,
          timestamp: this.now(),
          sender: "bus",
          recipient: p.agentId,
          type: "LOCK_REFUSED",
          payload: { agentId: p.agentId, filePath: p.filePath, lockId: p.lockId },
        });
      });
  }
}
