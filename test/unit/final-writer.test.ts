import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalWriter } from "../../src/artifacts/final-writer";
import { EXIT } from "../../src/runtime/exit";

describe("FinalWriter", () => {
  it("writes final.md with frontmatter and reports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "final-test-"));
    try {
      const w = new FinalWriter(dir);
      await w.write({
        outcome: "success",
        exitCode: EXIT.SUCCESS,
        reports: [
          { agentId: "a", report: "report from a" },
          { agentId: "b", report: "report from b" },
        ],
      });
      const content = await readFile(join(dir, "final.md"), "utf8");
      expect(content).toContain("status: success");
      expect(content).toContain("exit_code: 0");
      expect(content).toContain("## a");
      expect(content).toContain("report from b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
