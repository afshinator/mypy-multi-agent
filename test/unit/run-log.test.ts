import { describe, expect, it } from "vitest";
import { clock12, durHuman, renderRunLog } from "../../src/batch/run-log";

describe("clock12", () => {
  it("renders 12-hour time with seconds", () => {
    const d = new Date(2026, 10, 6, 18, 0, 34); // 6:00:34 pm local
    expect(clock12(d.getTime())).toBe("6:00 pm (34s)");
  });
});

describe("durHuman", () => {
  it("renders under a second, seconds, and minutes", () => {
    expect(durHuman(34)).toBe("<1 sec");
    expect(durHuman(1710)).toBe("1.7 sec");
    expect(durHuman(10_000)).toBe("10 sec");
    expect(durHuman(93_400)).toBe("1 min 33 sec");
  });
});

describe("renderRunLog", () => {
  const conversation = [
    { timestamp: 1000, type: "AGENT_REGISTER", sender: "implementer", payload: { model: "a/b" } },
    {
      timestamp: 2000,
      type: "WORK_ORDER",
      sender: "supervisor",
      recipient: "implementer",
      payload: { taskId: "task-1", action: "Do the thing. Then verify.\nMore." },
    },
    {
      timestamp: 3000,
      type: "INTENT_TO_MODIFY",
      sender: "implementer",
      payload: { intent: "bash" },
    },
    { timestamp: 93_000, type: "FINAL_REPORT", sender: "implementer", payload: { report: "done" } },
    { timestamp: 94_000, type: "FINALIZED", payload: { outcome: "success", exitCode: 0 } },
  ];
  const tools = [
    {
      timestamp: 2500,
      agentId: "implementer",
      toolName: "read",
      args: { path: "/x/detailParser.ts" },
      durationMs: 34,
    },
    {
      timestamp: 3000,
      agentId: "implementer",
      toolName: "bash",
      args: { command: "ls" },
      durationMs: 1500,
      isError: true,
      error: "no such file",
    },
  ];
  const spans = [
    { name: "run", start_time: 1000, end_time: 94_000 },
    { name: "validation.command", start_time: 91_000, end_time: 94_000 },
  ];

  it("renders the numbered timeline: banner work, turn bracket, indentation, error", () => {
    const { lines, summary } = renderRunLog(conversation, tools, spans, 53);
    const text = lines.join("\n");

    expect(text).toContain("▸ run starts");
    expect(text).toContain("· implementer registered (b)");
    expect(text).toContain("#53 ▸ supervisor → implementer: work order task-1 — Do the thing.");
    expect(text).toContain("▸ implementer turn begins");
    expect(text).toContain("read detailParser.ts (<1 sec)");
    expect(text).toContain("bash ls (1.5 sec)  ⚠ no such file");
    expect(text).toContain("· intent to modify bash");
    expect(text).toContain("▸ implementer turn ends (1 min 31 sec)");
    expect(text).toContain("▸ validation begins");
    expect(text).toContain("▸ validation ends (3 sec)");
    expect(text).toContain("✔ finalized success (exit 0)");

    // Tools are indented under the turn; the turn line is not.
    const toolLine = lines.find((l) => l.includes("read detailParser.ts"));
    expect(toolLine).toMatch(/ {4}read detailParser.ts/);

    const footer = summary.join("\n");
    expect(footer).toContain("longest event: implementer turn — lines");
    expect(footer).toContain("errors: 1");
    expect(footer).toContain("line");
    expect(footer).toContain("no such file");
  });

  it("says errors: 0 when nothing failed", () => {
    const { summary } = renderRunLog(
      conversation,
      tools.map((t) => ({ ...t, isError: false, error: undefined })),
      spans,
      53,
    );
    expect(summary.join("\n")).toContain("errors: 0");
  });
});
