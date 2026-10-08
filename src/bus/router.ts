/**
 * F1/F2 policy for the bus: drop invalid frames, send a correlated ERROR for
 * F2, and return valid frames to src/runtime/runtime.ts for agent routing.
 * Called per frame from runtime.ts.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";
import { classifyFrame } from "./message-validator";

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
 * Returns the parsed envelope for valid frames, `undefined` for f1/f2 (already
 * logged, counted, and answered via `deps`).
 */
export function routeFrame(line: string, deps: RouteDeps): A2AEnvelope | undefined {
  const c = classifyFrame(line);
  if (c.kind === "f1") {
    deps.malformed(c.reason);
    deps.log({ event: "f1", reason: c.reason });
    return undefined;
  }
  if (c.kind === "f2") {
    const e = c.envelope;
    deps.sink.fail(e.correlationId, "invalid payload");
    // No deps.log here: the ERROR reply below is logged by the emitter as an
    // ERROR entry, so logging in the router too would double-count F2.
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
    return undefined;
  }
  return c.envelope;
}
