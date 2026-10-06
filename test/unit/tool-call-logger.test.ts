import { describe, expect, it, vi } from "vitest";
import { toolCallLogger } from "../../src/peer/tool-call-logger";
import { ConversationLog } from "../../src/logging/conversation-log";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Capture handlers by event name from a mock pi. */
function captureHandlers() {
  const handlers = new Map<string, (event: unknown) => void>();
  const pi = {
    on: vi.fn((event: string, h: (e: unknown) => void) => {
      handlers.set(event, h);
      return () => {};
    }),
  } as unknown as ExtensionAPI;
  const log = { append: vi.fn(async () => {}) } as unknown as ConversationLog;
  toolCallLogger("peer1", log)(pi);
  return { handlers, log };
}

describe("toolCallLogger", () => {
  it("logs a completed tool call with duration", async () => {
    const { handlers, log } = captureHandlers();
    const start = handlers.get("tool_execution_start")!;
    const end = handlers.get("tool_execution_end")!;
    start({ toolCallId: "c1", toolName: "read", args: { path: "x" } });
    end({ toolCallId: "c1", toolName: "read", args: { path: "x" }, isError: false, result: {} });
    await vi.waitFor(() => expect(log.append).toHaveBeenCalled());
    const entry = (log.append as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(entry).toMatchObject({ agentId: "peer1", toolName: "read", toolCallId: "c1", args: { path: "x" }, isError: false });
    expect(entry.durationMs).toBeTypeOf("number");
  });

  it("records the error flag", async () => {
    const { handlers, log } = captureHandlers();
    const end = handlers.get("tool_execution_end")!;
    end({ toolCallId: "c2", toolName: "bash", args: { command: "ls" }, isError: true });
    await vi.waitFor(() => expect(log.append).toHaveBeenCalled());
    expect((log.append as ReturnType<typeof vi.fn>).mock.calls[0]![0].isError).toBe(true);
  });
});
