/**
 * Bus-level lifecycle signals (stop/kill/dispatch). Signal-only; OS process
 * termination is PaneManager's job. Owned by the Runtime composition layer.
 */
import type { A2AEnvelope, EventType } from "../contracts/a2a-schema";
import type { SessionState } from "./session-state";

/** Payload shape for a WORK_ORDER envelope; produced by Runtime.dispatch. */
export interface WorkOrder {
  taskId: string;
  action: string;
  contextFiles: string[];
  constraints: string[];
  localDoD: string;
}

export interface SignalSink {
  emit(envelope: A2AEnvelope): void;
}

/**
 * stop/kill mutate the session state via the SessionState authority; real
 * process termination is L8. The supervisor is the policy owner, not this class.
 */
export class ControlPlane {
  private seq = 0;

  constructor(
    private readonly session: SessionState,
    private readonly sink: SignalSink,
    private readonly onStop?: (agentId: string | "all") => void,
  ) {}

  stopAgent(agentId: string, reason?: string): void {
    this.onStop?.(agentId);
    this.sink.emit(this.envelope(agentId, "STOP_AGENT", { agentId, reason }));
  }

  stopAll(reason?: string): void {
    this.session.enterFinalizing();
    this.onStop?.("all");
    this.sink.emit(this.envelope("all", "STOP_ALL", { reason }));
  }

  killAll(reason?: string): void {
    this.session.abort();
    this.onStop?.("all");
    this.sink.emit(this.envelope("all", "KILL_ALL", { reason }));
  }

  /** Gate new work on the session phase. Returns false (and emits nothing) when finalizing/terminal. */
  dispatchWork(agentId: string, workOrder: WorkOrder): boolean {
    if (!this.session.acceptsNewWork()) return false;
    this.sink.emit(this.envelope(agentId, "WORK_ORDER", workOrder));
    return true;
  }

  private envelope(recipient: string, type: EventType, payload: unknown): A2AEnvelope {
    return {
      id: `ctl-${++this.seq}`,
      timestamp: Date.now(),
      sender: "supervisor",
      recipient,
      type,
      payload,
    };
  }
}
