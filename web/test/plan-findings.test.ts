import { describe, expect, it } from "vitest";
import type { DirEntry, DirReader, FileText } from "../lib/discovery";
import { loadPlanFindings } from "../lib/plan-findings";

function reader(files: Record<string, string>): DirReader {
  return {
    async list(): Promise<DirEntry[]> {
      return [];
    },
    async readText(path: string): Promise<FileText | null> {
      const text = files[path];
      return text === undefined ? null : { text };
    },
  };
}

describe("loadPlanFindings", () => {
  it("returns typed plan/findings with null for missing files", async () => {
    const doc = await loadPlanFindings(reader({ "r/plan.md": "# P", "r/findings.md": "# F" }), "r");
    expect(doc).toEqual({ plan: "# P", findings: "# F" });
  });

  it("marks each missing file as null independently", async () => {
    const doc = await loadPlanFindings(reader({ "r/plan.md": "# P" }), "r");
    expect(doc.plan).toBe("# P");
    expect(doc.findings).toBeNull();
  });
});
