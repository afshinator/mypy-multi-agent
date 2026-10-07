/**
 * Second pass of the bus trust boundary: applies the F1/F2 policy and hands
 * valid frames back to the runtime for agent routing. Called per frame from
 * src/runtime/runtime.ts.
 */
import { classifyFrame } from "./message-validator";
import type { A2AEnvelope } from "../contracts/a2a-schema";

export interface PendingRequestFailureSink {
  fail(correlationId: string | undefined, reason: string): void;
}

export interface RouteDeps {
  sink: PendingRequestFailureSink;
  malformed: (reason: string) => void;
  sendError: (envelope: A2AEnvelope) => void;
  log: (entry: Record<string, unknown>) => void;
}

/**
 * Dispatch one frame.
 * F1: log + count, drop, no reply, never retry.
 * F2: log + correlated ERROR + pending-request failure, drop before agent logic.
 * valid: return for the caller to route to agent logic.
 */
export function routeFrame(line: string, deps: RouteDeps): "valid" | "f1" | "f2" {
  const c = classifyFrame(line);
  if (c.kind === "f1") {
    deps.malformed(c.reason);
    deps.log({ event: "f1", reason: c.reason });
    return "f1";
  }
  if (c.kind === "f2") {
    const e = c.envelope;
    deps.sink.fail(e.correlationId, "invalid payload");
    deps.log({ event: "f2", envelopeId: e.id, correlationId: e.correlationId });
    deps.sendError({
      // Suffix marks the reply as bus-generated so it cannot collide with a
      // real envelope id, and ties it back to the offending frame.
      id: `${e.id}:f2`,
      correlationId: e.correlationId,
      timestamp: Date.now(),
      sender: "bus",
      recipient: e.sender,
      type: "ERROR",
      payload: { code: "F2_INVALID_PAYLOAD", message: "invalid payload", correlationId: e.correlationId },
    });
    return "f2";
  }
  return "valid";
}
