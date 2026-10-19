/**
 * Peer-side turn/tool span lifecycle: one active turn at a time, tool spans
 * parented to it, and abort closes every open span under the turn. The tracer
 * itself stays generic; this owns the peer's "current turn" association.
 */
import type { SpanHandle, SpanStatus, Tracing } from "./tracing";

interface ActiveTurn {
  span: SpanHandle;
  scopeId: string;
  tools: SpanHandle[];
}

export class PeerTraceState {
  private turn: ActiveTurn | null = null;

  constructor(readonly tracer: Tracing) {}

  startTurn(parent: SpanHandle | null, scopeId: string, agentId: string): SpanHandle {
    const span = this.tracer.startSpan("peer.turn", {
      parent,
      kind: "work-order-level",
      scopeId,
      agentId,
    });
    this.turn = { span, scopeId, tools: [] };
    return span;
  }

  /** Extract the injected parent from an inbound envelope, then start a turn. */
  startTurnFrom(env: Record<string, unknown>, scopeId: string, agentId: string): SpanHandle | null {
    const parent = this.tracer.extract(env);
    if (!parent) return null;
    return this.startTurn(parent, scopeId, agentId);
  }

  startTool(operationId: string, tool: string, agentId: string): SpanHandle | undefined {
    const turn = this.turn;
    if (!turn) return undefined;
    const span = this.tracer.startSpan("tool", {
      parent: turn.span,
      kind: "work-order-level",
      scopeId: turn.scopeId,
      agentId,
      operationId,
      attrs: { tool },
    });
    turn.tools.push(span);
    return span;
  }

  endTool(span: SpanHandle, status: SpanStatus = "ok"): void {
    const turn = this.turn;
    if (turn) {
      const i = turn.tools.indexOf(span);
      if (i >= 0) turn.tools.splice(i, 1);
    }
    this.tracer.endSpan(span, status);
  }

  endTurn(status: SpanStatus = "ok"): void {
    const turn = this.turn;
    if (!turn) return;
    // An aborted turn closes its open tool spans too, never leaving them dangling.
    for (const tool of turn.tools) this.tracer.endSpan(tool, status);
    turn.tools.length = 0;
    this.tracer.endSpan(turn.span, status);
    this.turn = null;
  }
}
