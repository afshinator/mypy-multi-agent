/**
 * toolCallLogger tracing: tool_execution_start/end mint/close a tool span via
 * the peer trace state, without touching the tool-calls.jsonl writer.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ConversationLog } from "../../src/logging/conversation-log";
import { toolCallLogger } from "../../src/peer/tool-call-logger";

describe("toolCallLogger tracing", () => {
  it("mints a tool span per invocation, parented to the active turn, and closes it", async () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const pi = {
      on: vi.fn((event: string, h: (e: unknown) => void) => {
        handlers.set(event, h);
        return () => {};
      }),
    } as unknown as ExtensionAPI;
    const log = { append: vi.fn(async () => {}) } as unknown as ConversationLog;
    const trace = {
      startTool: vi.fn(() => "tool-span"),
      endTool: vi.fn(),
    };
    toolCallLogger("peer1", log, trace as never)(pi);

    const start = handlers.get("tool_execution_start");
    expect(start).toBeDefined();
    start?.({ toolCallId: "call-7", toolName: "read", args: {} });
    expect(trace.startTool).toHaveBeenCalledWith("call-7", "read", "peer1");

    const end = handlers.get("tool_execution_end");
    expect(end).toBeDefined();
    end?.({ toolCallId: "call-7", toolName: "read", args: {}, isError: true });
    expect(trace.endTool).toHaveBeenCalledWith("tool-span", "error");
  });
});
