import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCallLog } from "../../src/logging/tool-call-log";

describe("ToolCallLog", () => {
  it("appends one JSON object per tool call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-log-test-"));
    try {
      const path = join(dir, "tool-calls.jsonl");
      const log = new ToolCallLog(path);
      await log.append({ timestamp: 1, agentId: "a", toolName: "bash", toolCallId: "c1", args: { command: "ls" } });
      await log.append({ timestamp: 2, agentId: "a", toolName: "read", toolCallId: "c2", args: { path: "x" }, isError: true, durationMs: 3 });
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual({ timestamp: 1, agentId: "a", toolName: "bash", toolCallId: "c1", args: { command: "ls" } });
      expect(JSON.parse(lines[1]!)).toMatchObject({ toolName: "read", isError: true, durationMs: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
