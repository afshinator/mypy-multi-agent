/**
 * Direct peer-to-peer PROMPT/RESPONSE over the shared correlation registry; no
 * second correlator.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";
import type { SessionState } from "../control/session-state";
import type { CorrelationRegistry } from "./correlation-registry";
import { PeerTerminalError } from "./peer-terminal-error";
import type { AgentState } from "./state-machine";

/**
 * sendPrompt opens a correlation and awaits RESPONSE; an incoming PROMPT
 * reactivates a DONE peer to WORKING unless the session is FINALIZING.
 * awaitResponse reuses the same registry with an `await:` key prefix.
 */
export class PeerMessaging {
  private seq = 0;
  /** Latest inbound envelope per `await:` key, for reports that arrive before the await opens. */
  private pending = new Map<string, A2AEnvelope>();
  /** `prompt-N` correlation id -> target agent, so an in-flight prompt is failed when its peer terminates. */
  private promptTargets = new Map<string, string>();

  constructor(
    private readonly registry: CorrelationRegistry,
    private readonly emit: (env: A2AEnvelope) => void,
    private readonly session: SessionState,
    private readonly states: Map<string, AgentState>,
  ) {}

  sendPrompt(
    fromAgent: string,
    toAgent: string,
    text: string,
    timeoutMs: number,
  ): Promise<A2AEnvelope> {
    // A terminal peer has no socket to answer; fail before opening a waiter (and
    // before emitting) rather than running the caller to the timeout.
    const targetState = this.states.get(toAgent);
    if (targetState === "STOPPED" || targetState === "CRASHED") {
      return Promise.reject(
        new PeerTerminalError(`peer ${toAgent} is ${targetState}; not sending`),
      );
    }
    const seq = ++this.seq;
    const correlationId = `prompt-${seq}`;
    const waiter = this.registry.open(correlationId, timeoutMs);
    this.promptTargets.set(correlationId, toAgent);
    void waiter.then(
      () => this.promptTargets.delete(correlationId),
      () => this.promptTargets.delete(correlationId),
    );
    this.emit({
      id: `prompt-${seq}`,
      correlationId,
      timestamp: Date.now(),
      sender: fromAgent,
      recipient: toAgent,
      type: "PROMPT",
      payload: { agentId: toAgent, text },
    });
    return waiter;
  }

  /** Block until an inbound message (PROMPT or RESPONSE) is addressed to `agentId`. */
  awaitResponse(agentId: string, timeoutMs: number): Promise<A2AEnvelope> {
    if (!this.session.isActive) {
      return Promise.reject(new Error("session is finalizing; await_response rejected"));
    }
    const key = `await:${agentId}`;
    // Open first so a resolve in the gap between the pending check and now
    // delivers to the just-registered waiter instead of being lost.
    const waiter = this.registry.open(key, timeoutMs);
    const pending = this.pending.get(key);
    if (pending) {
      this.pending.delete(key);
      this.registry.resolve(key, pending);
      return waiter;
    }
    // Pending wins over terminal state: a report buffered before the peer stopped
    // or crashed must still be delivered. Only then does a terminal peer fail
    // fast — and because the check is state-based, every later await rejects too,
    // not just the first (which the one-shot crash buffer did).
    const state = this.states.get(agentId);
    if (state === "STOPPED" || state === "CRASHED") {
      this.registry.failWith(key, new PeerTerminalError(`peer ${agentId} is ${state}`));
    }
    return waiter;
  }

  onPrompt(envelope: A2AEnvelope): void {
    const target = (envelope.payload as { agentId: string }).agentId;
    if (this.states.get(target) === "DONE" && this.session.isActive) {
      this.states.set(target, "WORKING");
    }
    this.resolveAwait(envelope, target);
  }

  onResponse(envelope: A2AEnvelope): void {
    if (envelope.correlationId !== undefined) {
      this.registry.resolve(envelope.correlationId, envelope);
    }
    this.resolveAwait(envelope);
  }

  /** Wake `await:<agentId>` when a peer crashes (AGENT_CRASHED's sender is
   * "bus", so the normal sender/recipient keys would miss it). */
  onCrash(agentId: string, envelope: A2AEnvelope): void {
    this.failPeer(agentId, `peer ${agentId} crashed`);
    const key = `await:${agentId}`;
    if (this.registry.hasWaiter(key)) {
      this.registry.resolve(key, envelope);
    } else {
      this.pending.set(key, envelope);
    }
  }

  /** A peer was stopped (graceful): fail any in-flight prompt and any open
   * await. A later `awaitResponse` is rejected by the terminal-state check. */
  onStopped(agentId: string): void {
    this.failPeer(agentId, `peer ${agentId} is STOPPED`);
    this.registry.fail(`await:${agentId}`, `peer ${agentId} is STOPPED`);
  }

  /** Reject in-flight `sendPrompt` waiters targeting `agentId`. Touches ONLY
   * `prompt-N` keys, never `await:` (which the crash/stop paths own) — a wider
   * sweep would break the F6 crash-envelope delivery. */
  private failPeer(agentId: string, reason: string): void {
    for (const [correlationId, target] of this.promptTargets) {
      if (target !== agentId) continue;
      this.promptTargets.delete(correlationId);
      this.registry.failWith(correlationId, new PeerTerminalError(reason));
    }
  }

  /** Drop buffered envelopes for `await:<agentId>` (e.g. a stale AGENT_CRASHED
   * from a prior connection) so a reconnected peer's await isn't answered early. */
  clearPending(agentId: string): void {
    this.pending.delete(`await:${agentId}`);
  }

  /**
   * Wake `await_response` waiters for both endpoints: `await:<recipient>` (a
   * message addressed to the waiter) and `await:<sender>` (a message from the
   * awaited peer — the common case, since a peer's report is addressed to the
   * supervisor, not to the peer being awaited). A resolve with no open waiter
   * is buffered so a later `awaitResponse` returns the latest envelope instead
   * of timing out.
   */
  private resolveAwait(envelope: A2AEnvelope, target?: string): void {
    const keys = new Set<string>([`await:${envelope.recipient}`, `await:${envelope.sender}`]);
    if (target !== undefined) keys.add(`await:${target}`);
    for (const key of keys) {
      if (this.registry.hasWaiter(key)) {
        this.registry.resolve(key, envelope);
      } else {
        this.pending.set(key, envelope);
      }
    }
  }
}
