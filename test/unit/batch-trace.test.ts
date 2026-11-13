import { describe, expect, it } from "vitest";
import { renderTrace } from "../../src/batch/trace";

describe("renderTrace", () => {
  it("renders each tool with its duration and a gap line between distant tools", () => {
    const text = renderTrace(
      [
        { atMs: 0, kind: "tool", tool: "bash", detail: "ls", durationMs: 10 },
        {
          atMs: 2000,
          kind: "tool",
          tool: "grep",
          detail: "criteriaMismatches src/",
          durationMs: 300,
        },
      ],
      { costUsd: 0.01, turns: 1, wallMs: 2500 },
    );

    expect(text).toContain("bash  ls · 10ms");
    expect(text).toContain("grep  criteriaMismatches src/ · 300ms");
    expect(text).toContain("· gap 2.0s");
    expect(text).toContain("done — wall 2.5s · tools 0.3s · 1 turns · $0.0100");
  });

  it("folds away a sub-threshold gap instead of printing noise", () => {
    const text = renderTrace(
      [
        { atMs: 0, kind: "tool", tool: "bash", detail: "a", durationMs: 10 },
        { atMs: 200, kind: "tool", tool: "bash", detail: "b", durationMs: 20 },
      ],
      { costUsd: 0, turns: 1, wallMs: 400 },
    );

    expect(text).not.toContain("gap");
  });

  it("renders turn boundaries and a token sum when reported", () => {
    const text = renderTrace(
      [
        { atMs: 100, kind: "turn", turn: 1 },
        { atMs: 300, kind: "tool", tool: "read", detail: "f.ts", durationMs: 8 },
      ],
      { costUsd: 0.5, turns: 1, inputTokens: 100, outputTokens: 50, wallMs: 1000 },
    );

    expect(text).toContain("turn 1 ends");
    expect(text).toContain("150 tokens");
    expect(text).toContain("$0.5000");
  });
});
