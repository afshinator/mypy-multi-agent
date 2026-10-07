/**
 * Direct peer-to-peer PROMPT/RESPONSE over the shared correlation registry; no
 * second correlator.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";
import { CorrelationRegistry } from "./correlation-registry";
import type { AgentState } from "./state-machine";
import type { SessionState } from "../control/session-state";

/**
 * sendPrompt opens a correlation and awaits RESPONSE; an incoming PROMPT
 * reactivates a DONE peer to WORKING unless the session is FINALIZING.
 * awaitResponse reuses the same registry with an `await:` key prefix.
 */
export class PeerMessaging {
  private seq = 0;

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
    return this.registry.open(`await:${agentId}`, timeoutMs);
  }

  onPrompt(envelope: A2AEnvelope): void {
    const target = (envelope.payload as { agentId: string }).agentId;
    if (this.states.get(target) === "DONE" && this.session.canReactivate()) {
      this.states.set(target, "WORKING");
    }
    this.registry.resolve(`await:${target}`, envelope);
  }

  onResponse(envelope: A2AEnvelope): void {
    if (envelope.correlationId !== undefined) {
      this.registry.resolve(envelope.correlationId, envelope);
    }
    this.registry.resolve(`await:${envelope.recipient}`, envelope);
  }
}
