/**
 * Unit tests for the peer-side change notifier (P1-1): tells the runtime a
 * mutating tool succeeded so the validation gate arms.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { payloadSchemas } from "../../src/contracts/a2a-schema";
import { changeNotifier } from "../../src/peer/change-notifier";

function capture() {
  const handlers = new Map<string, (event: unknown) => void>();
  const pi = {
    on: vi.fn((event: string, h: (e: unknown) => void) => {
      handlers.set(event, h);
      return () => {};
    }),
  } as unknown as ExtensionAPI;
  const send = vi.fn();
  changeNotifier("peer1", send)(pi);
  const start = handlers.get("tool_execution_start")!;
  const end = handlers.get("tool_execution_end")!;
  const run = (toolName: string, args: unknown, isError = false) => {
    start({ toolCallId: "c1", toolName, args });
    end({ toolCallId: "c1", toolName, isError });
  };
  return { run, send };
}

describe("changeNotifier", () => {
  it("emits INTENT_TO_MODIFY for a successful edit", () => {
    const { run, send } = capture();
    run("edit", { path: "src/x.ts" });
    expect(send).toHaveBeenCalledOnce();
    const env = send.mock.calls[0]![0] as A2AEnvelope;
    expect(env).toMatchObject({
      sender: "peer1",
      recipient: "supervisor",
      type: "INTENT_TO_MODIFY",
      payload: { agentId: "peer1", filePath: "src/x.ts" },
    });
    expect(payloadSchemas.INTENT_TO_MODIFY.safeParse(env.payload).success).toBe(true);
  });

  it("emits for a successful write", () => {
    const { run, send } = capture();
    run("write", { path: "src/y.ts" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("ignores read-only tools", () => {
    const { run, send } = capture();
    run("read", { path: "src/x.ts" });
    run("grep", { pattern: "x" });
    expect(send).not.toHaveBeenCalled();
  });

  it("emits for a successful bash call (issue #29)", () => {
    // bash can mutate files (git apply, sed -i, >), so it must arm the gate or a
    // run that changed code through bash finalizes with validation skipped.
    const { run, send } = capture();
    run("bash", { command: "printf CHANGED > f.txt" });
    expect(send).toHaveBeenCalledOnce();
    const calls = send.mock.calls as unknown as [A2AEnvelope][];
    const env = calls[0]?.[0];
    expect(env).toMatchObject({
      type: "INTENT_TO_MODIFY",
      payload: { agentId: "peer1", intent: "bash" },
    });
    expect(payloadSchemas.INTENT_TO_MODIFY.safeParse(env?.payload).success).toBe(true);
  });

  it("ignores a failed mutation", () => {
    const { run, send } = capture();
    run("edit", { path: "src/x.ts" }, true);
    expect(send).not.toHaveBeenCalled();
  });

  it("latches: later successful mutations do not re-emit", () => {
    const { run, send } = capture();
    run("edit", { path: "a.ts" });
    run("write", { path: "b.ts" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("tolerates missing args", () => {
    const { run, send } = capture();
    run("write", undefined);
    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0]![0] as A2AEnvelope).payload).toMatchObject({
      filePath: "<unknown>",
    });
  });
});
