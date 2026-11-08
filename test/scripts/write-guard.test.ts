import { describe, expect, it } from "vitest";
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
    // A question that opens with an action verb is still a question, and must not license a write.
    ["Verify this for me.. and is that one PR or several?", "answer"],
    ["why did that prompt appear? then you needed me to verify a write?", "answer"],
    // Reading verbs ask for an answer, so they do not license a write either.
    ["verify the claim", "answer"],
    ["review this diff", "answer"],
    ["check the log for errors", "answer"],
    ["please review this", "answer"],
    ["can you review this?", "answer"],
    // A write asked for beside a read is still a write.
    ["review this diff and then fix it", "action"],
    ["verify the claim and update the doc", "action"],
    // An explicit request stays an action, question mark or not.
    ["can you land it?", "action"],
    ["go ahead and land changes", "action"],
  ])("classifies %s as %s", (input, expected) => {
    expect(writeMode(input)).toBe(expected);
  });

  it.each([
    ["git status", false],
    ["printf hi > out.txt", true],
    ["grep x file > /dev/null", false],
    ["rm -f out.txt", true],
    // Quoted text is data, not a command: a script body that mentions rm is not an rm.
    ["bun -e 'console.log(1); rm -rf x; mkdir y'", false],
    ["grep -n 'rm -rf' README.md", false],
    ["echo 'a > b'", false],
    // An interpreter runs its payload, so there the quoted words do count.
    ['bash -c "rm -rf x"', true],
    ["find . -exec rm {} +", true],
    // One real write anywhere in a chain counts, even when the other segments are reads.
    ["cd repo && git init -q .git/scratch", true],
    ["sed -i 's/a/b/' f", true],
  ])("classifies shell command %s as a write: %s", (command, expected) => {
    expect(bashWrites(command)).toBe(expected);
  });

  function harness() {
    let inputHandler: ((event: { text: string }) => void) | undefined;
    let toolHandler: ((event: ToolCallEvent, ctx: Ctx) => Promise<unknown>) | undefined;
    guard({
      on(event, handler) {
        if (event === "input") inputHandler = handler as (event: { text: string }) => void;
        else toolHandler = handler as (event: ToolCallEvent, ctx: Ctx) => Promise<unknown>;
      },
    });
    return {
      input: (text: string) => inputHandler?.({ text }),
      tool: (event: ToolCallEvent) => toolHandler?.(event, ctx),
    };
  }

  const ctx: Ctx = { hasUI: true, ui: { confirm: async () => true } };
  const write: ToolCallEvent = { toolName: "write", input: { path: "x" } };
  const bash: ToolCallEvent = { toolName: "bash", input: { command: "rm -f x" } };
  const reads: ToolCallEvent = {
    toolName: "bash",
    input: { command: "grep -n 'rm -rf' notes.md" },
  };

  it("blocks a write on a question that asked for an answer", async () => {
    const h = harness();
    h.input("What does this do?");

    await expect(h.tool(write)).resolves.toMatchObject({ block: true });
  });

  it("blocks a write when the request only reads", async () => {
    const h = harness();
    h.input("review this diff");

    const result = (await h.tool(write)) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("asked for an answer");
  });

  it("blocks a write with no instruction, and asks in words instead of opening a dialog", async () => {
    const h = harness();
    h.input("Maybe inspect this");

    const result = (await h.tool(write)) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("without an explicit instruction");
    expect(result.reason).toContain("wait for the user's word");
  });

  it("allows a write for an explicit action request", async () => {
    const h = harness();
    h.input("Can you update this file?");

    await expect(h.tool(write)).resolves.toBeUndefined();
  });

  it("recomputes the mode for each input", async () => {
    const h = harness();
    h.input("Can you update this file?");
    await expect(h.tool(write)).resolves.toBeUndefined();
    h.input("What does this do?");

    await expect(h.tool(write)).resolves.toMatchObject({ block: true });
  });

  it("blocks a bash write, not only edit and write", async () => {
    const h = harness();
    h.input("What does this do?");

    await expect(h.tool(bash)).resolves.toMatchObject({ block: true });
  });

  it("never blocks a bash command that only mentions a write in quotes", async () => {
    const h = harness();
    h.input("What does this do?");

    await expect(h.tool(reads)).resolves.toBeUndefined();
  });

  it("keeps the unattended batch bypass", async () => {
    const previous = process.env.MYPY_UNATTENDED;
    process.env.MYPY_UNATTENDED = "1";
    try {
      const h = harness();
      h.input("What does this do?");
      await expect(h.tool(write)).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.MYPY_UNATTENDED;
      else process.env.MYPY_UNATTENDED = previous;
    }
  });
});
