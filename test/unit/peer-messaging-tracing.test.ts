/**
 * PeerMessaging tracing: sendPrompt mints a prompt span parented to the
 * sender's current span, injects traceparent, and closes on RESPONSE.
 */
import { describe, expect, it, vi } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { SessionState } from "../../src/control/session-state";
import { CorrelationRegistry } from "../../src/runtime/correlation-registry";
import { PeerMessaging } from "../../src/runtime/peer-messaging";
import { FieldsTracer } from "../../src/tracing/tracing";

const resp = (correlationId: string, from = "b", to = "a"): A2AEnvelope => ({
  id: "r1",
  correlationId,
  timestamp: 0,
  sender: from,
  recipient: to,
  type: "RESPONSE",
  payload: { agentId: from, text: "answer" },
});

describe("PeerMessaging tracing", () => {
  it("mints a prompt span parented to the sender's current span and injects traceparent", async () => {
    const r = new CorrelationRegistry();
    const emit = vi.fn();
    const tracer = new FieldsTracer();
    const run = tracer.startSpan("run", {
      parent: null,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    const m = new PeerMessaging(r, emit, new SessionState(), new Map(), {
      tracer,
      currentSpan: () => run,
    });
    const p = m.sendPrompt("supervisor", "b", "q", 1000);
    const env = (emit.mock.calls[0]?.[0] ?? {}) as A2AEnvelope;
    expect(env.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const correlationId = env.correlationId ?? "prompt-missing";
    const promptSpan = tracer.collect().find((s) => s.name === "prompt");
    expect(promptSpan).toMatchObject({
      parent_span_id: run.id,
      scope_id: correlationId,
      operation_id: correlationId,
      kind: "work-order-level",
      end_time: null,
    });
    // A matching RESPONSE closes the prompt span.
    m.onResponse(resp(correlationId));
    await expect(p).resolves.toMatchObject({ type: "RESPONSE" });
    expect(tracer.collect().find((s) => s.name === "prompt")?.end_time).not.toBeNull();
  });
});
