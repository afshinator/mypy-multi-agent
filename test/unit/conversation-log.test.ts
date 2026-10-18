/**
 * Unit tests for the conversation log module.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationLog, readJsonl } from "../../src/logging/conversation-log";

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
  it("reads JSONL records, skipping blank and malformed lines (issue #31)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "log-test-"));
    try {
      const path = join(dir, "records.jsonl");
      await writeFile(
        path,
        '{"a":1}\n\n{"a":2}\n not json \n{"a":3}\n123\nnull\n[1,2]\n{"a":4}\r\n',
      );
      expect(await readJsonl(path)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns no records for a missing file", async () => {
    expect(await readJsonl(join(tmpdir(), "definitely-missing", "x.jsonl"))).toEqual([]);
  });
});
