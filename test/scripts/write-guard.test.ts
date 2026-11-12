import { beforeEach, describe, expect, it } from "vitest";
import guard, {
  bashWrites,
  type Ctx,
  lastAssistantText,
  onMain,
  reconciled,
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
    // A user-invoked skill is the user's request for that skill's work, which writes.
    [
      '<skill name="retro" location="/x/SKILL.md">\nReferences are relative to /x.\n\n1. write the findings to docs/retro/x.md',
      "action",
    ],
    // "go ahead" authorises the work after a read verb, without naming a write verb.
    ["verify the assertions in 452, then go ahead", "action"],
    ["reverify your claims, then fix it", "action"],
    ["should I go ahead?", "answer"],
  ])("classifies %s as %s", (input, expected) => {
    expect(writeMode(input)).toBe(expected);
  });

  it.each([
    ["git status", false],
    // The command a triage turn was refused for in the 2026-11-09 session: reads only.
    [
      "sed -n '1,9p' f; echo '=== x ==='; rg -ln 'a|b' --glob '!docs/**' . f 2>/dev/null | head",
      false,
    ],
    ["printf hi > out.txt", true],
    ["grep x file > /dev/null", false],
    ["rm -f out.txt", true],
    // Quoted text in a non-interpreter is data, not a command.
    ["rg -n 'rm -rf' docs/", false],
    // An inline program is opaque: `bun -e` can write whatever its body says, so it is a write
    // whatever the body mentions (#491). `bun run test` runs a script file, not an inline program.
    ["bun -e 'console.log(1)'", true],
    ["bun run test", false],
    ['node -e \'require("fs").rmSync("x")\'', true],
    ["python3 -c 'print(1)'", true],
    // A module run is an inline program too, and the stream redirect is not a file write.
    ["python3 -m pip install x", true],
    // The same write behind a path, a wrapper or an assignment is the same write.
    [`/usr/bin/python3 -c 'open("x")'`, true],
    [`env python3 -c 'open("x")'`, true],
    ["sudo node -e '1'", true],
    ["MYPY_X=1 python3 -c 1", true],
    ["rg x 2>&1 | head", false],
    ["sed -i s/a/b/ f 2>&1 | head", true],
    ["python3 - <<'PY'\nopen('x','w').write('y')\nPY", true],
    ["grep -n 'rm -rf' README.md", false],
    ["echo 'a > b'", false],
    // An interpreter runs its payload, so there the quoted words do count.
    ['bash -c "rm -rf x"', true],
    ["find . -exec rm {} +", true],
    // One real write anywhere in a chain counts, even when the other segments are reads.
    ["cd repo && git init -q .git/scratch", true],
    ["sed -i 's/a/b/' f", true],
    // A path or a search term is data: only a command head writes.
    ["cat x.patch", false],
    ["rg -n patch docs/", false],
    ["patch -p1 < d.patch", true],
    ["unzip a.zip", true],
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
      tool: (event: ToolCallEvent, ctxOverride: Ctx = ctx) => toolHandler?.(event, ctxOverride),
    };
  }

  // The suite owns the branch state: with it absent the guard asks the real checkout, and the
  // answer would change with whatever branch the developer is on.
  const ctx: Ctx = {
    hasUI: true,
    ui: { confirm: async () => true },
    branch: "task/test",
    repoRoot: "/repo",
    sessionManager: { getBranch: () => reconciledTranscript },
  };
  const onMainCtx: Ctx = { ...ctx, branch: "main" };
  let reconciledTranscript: unknown[] = [];
  beforeEach(() => {
    // A batch sets this in its pane command (`src/batch/executor.ts:174`), and every test here states
    // the mode it exercises: leaving it set makes the guard take its bypass (`scripts/write-guard.ts:260`).
    delete process.env.MYPY_UNATTENDED;
    reconciledTranscript = [
      {
        message: {
          role: "assistant",
          content: "Smallest complete change: one line\nSkipped: no tests",
        },
      },
    ];
  });
  const write: ToolCallEvent = { toolName: "write", input: { path: "x" } };
  const inRepo: ToolCallEvent = { toolName: "edit", input: { path: "/repo/src/a.ts" } };
  const scratch: ToolCallEvent = { toolName: "write", input: { path: "/tmp/x.ts" } };
  const bash: ToolCallEvent = { toolName: "bash", input: { command: "rm -f x" } };
  const reads: ToolCallEvent = {
    toolName: "bash",
    input: { command: "grep -n 'rm -rf' notes.md" },
  };

  it.each([
    ["main", "/repo/src/a.ts", true],
    ["main", "/tmp/x.ts", false],
    ["task/x", "/repo/src/a.ts", false],
    [undefined, "/repo/src/a.ts", false],
    ["main", "", false],
  ])("gates a write on branch %s at %s: %s", (branch, path, expected) => {
    expect(onMain({ path, branch, repoRoot: "/repo" })).toBe(expected);
  });

  it.each([
    ["Smallest complete change: one line\nSkipped: no tests", true],
    ["Smallest complete change: one line", false],
    ["Skipped: no tests", false],
    ["SMALLEST COMPLETE CHANGE: x\nskipped: y", true],
    ["", false],
    [undefined, false],
  ])("accepts only a stated reconcile: %s -> %s", (text, expected) => {
    expect(reconciled(text)).toBe(expected);
  });

  it("reads the last assistant message, not the last entry", () => {
    const transcript = [
      { message: { role: "assistant", content: "Smallest complete change: a\nSkipped: b" } },
      { message: { role: "toolResult", content: "ok" } },
      { message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }] } },
    ];

    expect(lastAssistantText(transcript)).toBe("");
  });

  it("blocks the first write until the reconcile line is in the transcript", async () => {
    const h = harness();
    h.input("Can you update this file?");
    reconciledTranscript = [{ message: { role: "assistant", content: "Editing now." } }];

    const result = (await h.tool(inRepo)) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("'Smallest complete change: <the change>'");
  });

  it("allows the rest of the turn once the reconcile line was stated", async () => {
    const h = harness();
    h.input("Can you update this file?");

    await expect(h.tool(inRepo)).resolves.toBeUndefined();
    // A later message without the line does not re-open the gate inside the same turn.
    reconciledTranscript = [{ message: { role: "assistant", content: "next edit" } }];
    await expect(h.tool(inRepo)).resolves.toBeUndefined();
  });

  it("re-opens the gate on the next user turn", async () => {
    const h = harness();
    h.input("Can you update this file?");
    await expect(h.tool(inRepo)).resolves.toBeUndefined();
    reconciledTranscript = [{ message: { role: "assistant", content: "next edit" } }];
    h.input("Can you update this file again?");

    await expect(h.tool(inRepo)).resolves.toMatchObject({ block: true });
  });

  it("blocks a repo write on main even when the turn asked for the work", async () => {
    const h = harness();
    h.input("Can you update this file?");

    const result = (await h.tool(inRepo, onMainCtx)) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("git switch -c task/<name> origin/main");
  });

  it("leaves a scratch file outside the checkout alone on main", async () => {
    const h = harness();
    h.input("Can you update this file?");

    await expect(h.tool(scratch, onMainCtx)).resolves.toBeUndefined();
  });

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

  it("names the mode and the token that made a command a write (#491)", async () => {
    const h = harness();
    h.input("Maybe inspect this");

    // Before #491 the reason said only "without an explicit instruction", which cannot be told
    // apart from a guard bug — and one was mistaken for a bug during that session's triage.
    const result = (await h.tool({
      toolName: "bash",
      input: { command: "python3 - <<'PY'\nprint(1)\nPY" },
    })) as { block: boolean; reason: string };

    expect(result.block).toBe(true);
    expect(result.reason).toContain("mode ambiguous");
    // The token itself, not just the word "matched": that text is what makes a refusal diagnosable.
    expect(result.reason).toContain("matched: python3 runs an inline program");
  });

  it("refuses an inline program on a turn that only reads, whatever the program says (#491)", async () => {
    const h = harness();
    h.input("review this diff");

    // The gap that let two edits land on main: `python3 -` was not a write at all.
    await expect(
      h.tool({ toolName: "bash", input: { command: 'python3 -c \'open("x","w")\'' } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      h.tool({ toolName: "bash", input: { command: "node -e '1'" } }),
    ).resolves.toMatchObject({ block: true });
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
