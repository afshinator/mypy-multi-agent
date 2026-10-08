/**
 * Unit tests for the conversation log module.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationLog } from "../../src/logging/conversation-log";

describe("ConversationLog", () => {
  it("appends JSONL lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "log-test-"));
    try {
      const path = join(dir, "conversation.jsonl");
      const log = new ConversationLog(path);
      await log.append({ event: "x", id: 1 });
      await log.append({ event: "y", id: 2 });
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual({ event: "x", id: 1 });
      expect(JSON.parse(lines[1]!)).toEqual({ event: "y", id: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
