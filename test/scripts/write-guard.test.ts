import { describe, expect, it, vi } from "vitest";
import guard, {
  bashWrites,
  type Ctx,
  type ToolCallEvent,
  writeMode,
} from "../../scripts/write-guard";

describe("write guard", () => {
  it.each([
    ["What does this file do?", "answer"],
    ["Can you fix this bug?", "action"],
    ["Please update the docs", "action"],
    ["Explain the bug and then fix it.", "action"],
    ["Maybe inspect this", "ambiguous"],
  ])("classifies %s as %s", (input, expected) => {
    expect(writeMode(input)).toBe(expected);
  });

  it.each([
    ["git status", false],
    ["printf hi > out.txt", true],
    ["grep x file > /dev/null", false],
    ["rm -f out.txt", true],
  ])("classifies shell command %s as a write: %s", (command, expected) => {
    expect(bashWrites(command)).toBe(expected);
  });

  function harness(confirm: () => Promise<boolean> = async () => true) {
    let inputHandler: ((event: { text: string }) => void) | undefined;
    let toolHandler: ((event: ToolCallEvent, ctx: Ctx) => Promise<unknown>) | undefined;
    guard({
      on(event, handler) {
        if (event === "input") inputHandler = handler as (event: { text: string }) => void;
        else toolHandler = handler as (event: ToolCallEvent, ctx: Ctx) => Promise<unknown>;
      },
    });
    const input = (text: string) => inputHandler?.({ text });
    const tool = (event: ToolCallEvent, ctx: Ctx) =>
      toolHandler?.(event, { ...ctx, ui: { confirm } });
    return { input, tool };
  }

  const write: ToolCallEvent = { toolName: "write", input: { path: "x" } };
  const ui: Ctx = { hasUI: true, ui: { confirm: vi.fn(async () => true) } };

  it("blocks a write during an answer-only question without confirmation", async () => {
    const confirm = vi.fn(async () => true);
    const h = harness(confirm);
    h.input("What does this do?");

    await expect(h.tool(write, ui)).resolves.toMatchObject({ block: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("allows a write for an explicit action request", async () => {
    const h = harness();
    h.input("Can you update this file?");

    await expect(h.tool(write, ui)).resolves.toBeUndefined();
  });

  it("keeps confirmation for ambiguous input and blocks without UI", async () => {
    const confirm = vi.fn(async () => true);
    const h = harness(confirm);
    h.input("Maybe inspect this");

    await expect(h.tool(write, { hasUI: false, ui: ui.ui })).resolves.toMatchObject({
      block: true,
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("resets approval for each new input", async () => {
    const confirm = vi.fn(async () => true);
    const h = harness(confirm);
    h.input("Maybe inspect this");
    await expect(h.tool(write, ui)).resolves.toBeUndefined();
    h.input("What does this do?");

    await expect(h.tool(write, ui)).resolves.toMatchObject({ block: true });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("keeps the unattended batch bypass", async () => {
    const previous = process.env.MYPY_UNATTENDED;
    process.env.MYPY_UNATTENDED = "1";
    try {
      const h = harness();
      h.input("What does this do?");
      await expect(h.tool(write, { hasUI: false, ui: ui.ui })).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.MYPY_UNATTENDED;
      else process.env.MYPY_UNATTENDED = previous;
    }
  });
});
