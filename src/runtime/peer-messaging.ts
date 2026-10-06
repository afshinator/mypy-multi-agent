import type { A2AEnvelope } from "../contracts/a2a-schema";
import { CorrelationRegistry, CorrelationTimeoutError } from "./correlation-registry";
import type { AgentState } from "./state-machine";
import type { SessionState } from "../control/session-state";

/**
 * Direct peer collaboration over the one correlation registry (no second
 * correlator). sendPrompt opens a correlation and awaits RESPONSE; incoming
 * PROMPT reactivates a DONE peer to WORKING unless the session is FINALIZING.
 */
export class PeerMessaging {
  private seq = 0;
  private inboundWaiters = new Map<
    string,
    { resolve: (msg: A2AEnvelope) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly registry: CorrelationRegistry,
    private readonly emit: (env: A2AEnvelope) => void,
    private readonly session: SessionState,
    private readonly states: Map<string, AgentState>,
  ) {}

  sendPrompt(fromAgent: string, toAgent: string, text: string, timeoutMs: number): Promise<A2AEnvelope> {
    const seq = ++this.seq;
    const correlationId = `prompt-${seq}`;
    const waiter = this.registry.open(correlationId, timeoutMs);
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inboundWaiters.delete(agentId);
        reject(new CorrelationTimeoutError(`await_response ${agentId}`));
      }, timeoutMs);
      this.inboundWaiters.set(agentId, { resolve, reject, timer });
    });
  }

  onPrompt(envelope: A2AEnvelope): void {
    const target = (envelope.payload as { agentId: string }).agentId;
    if (this.states.get(target) === "DONE" && this.session.canReactivate()) {
      this.states.set(target, "WORKING");
    }
    this.resolveInbound(target, envelope);
  }

  onResponse(envelope: A2AEnvelope): void {
    if (envelope.correlationId !== undefined) {
      this.registry.resolve(envelope.correlationId, envelope);
    }
    this.resolveInbound(envelope.recipient, envelope);
  }

  private resolveInbound(agentId: string, envelope: A2AEnvelope): void {
    const w = this.inboundWaiters.get(agentId);
    if (!w) return;
    this.inboundWaiters.delete(agentId);
    clearTimeout(w.timer);
    w.resolve(envelope);
  }
}
