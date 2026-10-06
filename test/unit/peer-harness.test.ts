import { describe, expect, it, vi } from "vitest";
import { handleWorkOrder } from "../../src/peer/peer-harness";
import { payloadSchemas } from "../../src/contracts/a2a-schema";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

describe("handleWorkOrder", () => {
  it("runs the session and emits a FINAL_REPORT", async () => {
    const runSession = vi.fn(async () => "the report");
    const send = vi.fn();
    const report = await handleWorkOrder("peer1", "do x", { runSession, send, now: () => 123 });
    expect(report).toBe("the report");
    expect(runSession).toHaveBeenCalledWith("do x");
    expect(send).toHaveBeenCalledOnce();
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("FINAL_REPORT");
    expect(env.sender).toBe("peer1");
    expect(env.recipient).toBe("supervisor");
    expect(env.payload).toMatchObject({ agentId: "peer1", report: "the report" });
    expect(payloadSchemas.FINAL_REPORT.safeParse(env.payload).success).toBe(true);
  });

  it("runSession failure propagates and sends nothing", async () => {
    const runSession = vi.fn(async () => {
      throw new Error("boom");
    });
    const send = vi.fn();
    await expect(handleWorkOrder("peer1", "do x", { runSession, send, now: () => 123 })).rejects.toThrow("boom");
    expect(send).not.toHaveBeenCalled();
  });
});
