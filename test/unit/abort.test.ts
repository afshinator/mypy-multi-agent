/**
 * Unit tests for the abort module.
 */
import { describe, expect, it, vi } from "vitest";
import { abortSession } from "../../src/control/abort";
import { ControlPlane } from "../../src/control/control-plane";
import { SessionState } from "../../src/control/session-state";
import { EXIT } from "../../src/runtime/exit";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

function makeDeps(over: Record<string, unknown> = {}) {
  const sink = { emit: vi.fn() };
  const session = new SessionState();
  const controlPlane = new ControlPlane(session, sink);
  return {
    controlPlane,
    paneManager: { terminateAll: vi.fn(async () => {}) },
    bus: { stop: vi.fn(async () => {}) },
    finalWriter: { write: vi.fn(async () => {}) },
    graceMs: 0,
    sleep: vi.fn(async () => {}),
    session,
    sink,
    ...over,
  };
}

describe("abortSession", () => {
  it("graceful stop, force-kill, cleanup, then exit 2", async () => {
    const order: string[] = [];
    const d = makeDeps({
      paneManager: { terminateAll: async () => void order.push("kill") },
      bus: { stop: async () => void order.push("bus") },
      finalWriter: { write: async () => void order.push("write") },
      sleep: async () => void order.push("sleep"),
    });
    const code = await abortSession(d);
    expect(code).toBe(EXIT.USER_ABORTED);
    expect(order).toEqual(["sleep", "kill", "bus", "write"]);
    const types = d.sink.emit.mock.calls.map((c) => (c[0] as A2AEnvelope).type);
    expect(types).toEqual(["STOP_ALL", "KILL_ALL"]);
    expect(d.session.current).toBe("ABORTED");
  });

  it("writes an aborted final file", async () => {
    const write = vi.fn(async () => {});
    const d = makeDeps({ finalWriter: { write } });
    await abortSession(d);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ outcome: "aborted", exitCode: EXIT.USER_ABORTED }));
  });

  it("removes the socket via bus.stop", async () => {
    const stop = vi.fn(async () => {});
    const d = makeDeps({ bus: { stop } });
    await abortSession(d);
    expect(stop).toHaveBeenCalledOnce();
  });
});
