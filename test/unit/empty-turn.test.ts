import { describe, expect, it } from "vitest";
import {
  EMPTY_TURN_NUDGE,
  lastAssistantText,
  MAX_EMPTY_TURN_RETRIES,
  nextEmptyTurnPrompt,
} from "../../src/supervisor/empty-turn";

describe("nextEmptyTurnPrompt (issue #9)", () => {
  it("nudges an empty turn while the budget is unspent", () => {
    expect(nextEmptyTurnPrompt("", 0)).toBe(EMPTY_TURN_NUDGE);
    expect(nextEmptyTurnPrompt("   \n", 0)).toBe(EMPTY_TURN_NUDGE);
    expect(nextEmptyTurnPrompt("", MAX_EMPTY_TURN_RETRIES - 1)).toBe(EMPTY_TURN_NUDGE);
  });

  it("settles a non-empty turn, spending no budget", () => {
    expect(nextEmptyTurnPrompt("done", 0)).toBeUndefined();
    expect(nextEmptyTurnPrompt("done", MAX_EMPTY_TURN_RETRIES)).toBeUndefined();
  });

  it("settles once the budget is spent, so an empty turn cannot loop forever", () => {
    expect(nextEmptyTurnPrompt("", MAX_EMPTY_TURN_RETRIES)).toBeUndefined();
    expect(nextEmptyTurnPrompt("", MAX_EMPTY_TURN_RETRIES + 1)).toBeUndefined();
    expect(nextEmptyTurnPrompt("", 2, 2)).toBeUndefined();
  });
});

describe("lastAssistantText", () => {
  it("reads string and block content", () => {
    expect(lastAssistantText([{ role: "assistant", content: "hello" }])).toBe("hello");
    expect(
      lastAssistantText([
        {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ]),
    ).toBe("ab");
  });

  it("uses the last assistant message, skipping later tool messages", () => {
    expect(
      lastAssistantText([
        { role: "assistant", content: "first" },
        { role: "tool", content: "result" },
      ]),
    ).toBe("first");
  });

  it("is empty with no assistant message, or a non-text one", () => {
    expect(lastAssistantText([])).toBe("");
    expect(lastAssistantText([{ role: "user", content: "hi" }])).toBe("");
    expect(
      lastAssistantText([{ role: "assistant", content: [{ type: "image", data: "x" }] }]),
    ).toBe("");
    expect(lastAssistantText([{ role: "assistant" }, null, "junk"])).toBe("");
  });
});
