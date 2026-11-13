import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EventTail,
  eventLine,
  questionInPane,
  startLines,
  waitingLine,
} from "../../src/batch/progress";

// Built the same way the source builds it: no literal escape in either file.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);
const event = (fields: Record<string, unknown>): string => JSON.stringify(fields);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mypi-progress-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("startLines", () => {
  it("names the run, its worktree, branch, base, pane and deadline", () => {
    const lines = startLines({
      batch: "0008-rung3-t48",
      ticket: 48,
      slug: "b-0008-rung3-t48-t48",
      worktree: "../ma-wt-b-0008-rung3-t48-t48",
      base: "e20fe33",
      paneId: "w2E:p1",
      deadline: new Date("2026-11-06T18:02:00").getTime(),
    });
    const text = lines.join("\n");
    expect(text).toContain("0008-rung3-t48  #48  b-0008-rung3-t48-t48");
    expect(text).toContain("branch task/b-0008-rung3-t48-t48  base e20fe33");
    expect(text).toContain("supervisor pane w2E:p1 — watch: herdr pane read w2E:p1");
    expect(text).toContain("deadline 18:02:00");
    expect(text).not.toMatch(ANSI);
  });

  it("names the kind prepare accepted, and says nothing when there is none (#415)", () => {
    const base = {
      batch: "0012-docs-414",
      ticket: 414,
      slug: "b-0012-docs-414-t414",
      worktree: "../ma-wt-b-0012-docs-414-t414",
      base: "main",
      paneId: "w2K:p1",
      deadline: 0,
    };
    expect(startLines({ ...base, kind: "writer" })[0]).toBe(
      "0012-docs-414  #414  writer  b-0012-docs-414-t414",
    );
    // A `launch`ed ticket never went through prepare, so there is no kind to name.
    expect(startLines(base)[0]).toBe("0012-docs-414  #414  b-0012-docs-414-t414");
  });
});

describe("eventLine", () => {
  it("names the ticket and the work order's first sentence (#577)", () => {
    const at = new Date("2026-11-06T17:33:00").getTime();
    expect(
      eventLine(
        event({
          type: "WORK_ORDER",
          sender: "supervisor",
          recipient: "implementer",
          timestamp: at,
          payload: {
            taskId: "task-1",
            action:
              "Implement the full DoD for #53 (zero fields must store failed). Read these files.\nMore.",
          },
        }),
        53,
      ),
    ).toBe(
      "17:33:00 #53 supervisor -> implementer: work order task-1 — Implement the full DoD for #53 (zero fields must store failed).",
    );
  });

  it("names the sender and what it did, with the event's own clock", () => {
    const at = new Date("2026-11-06T17:33:00").getTime();
    expect(
      eventLine(
        event({
          type: "AGENT_REGISTER",
          sender: "reviewer",
          timestamp: at,
          payload: { model: "a/b" },
        }),
      ),
    ).toBe("17:33:00 reviewer registered (a/b)");
    expect(
      eventLine(
        event({
          type: "WORK_ORDER",
          sender: "supervisor",
          recipient: "implementer",
          timestamp: at,
          payload: { taskId: "task-1" },
        }),
      ),
    ).toBe("17:33:00 supervisor -> implementer: work order task-1");
    expect(
      eventLine(
        event({
          type: "INTENT_TO_MODIFY",
          sender: "implementer",
          timestamp: at,
          payload: { intent: "bash" },
        }),
      ),
    ).toBe("17:33:00 implementer: intent to modify bash");
    expect(
      eventLine(
        event({
          type: "FINAL_REPORT",
          sender: "implementer",
          timestamp: at,
          payload: { report: "**FINAL_REPORT — NOT DONE.**\n\nmore" },
        }),
      ),
    ).toBe("17:33:00 implementer: FINAL_REPORT FINAL_REPORT — NOT DONE.");
  });

  it("names the runtime events that matter most when a run fails", () => {
    expect(
      eventLine(
        event({
          type: "ERROR",
          event: "gate-rejected",
          term: "validation",
          detail: "bun run check",
        }),
      ),
    ).toBe("runtime: gate-rejected validation (bun run check)");
    expect(eventLine(event({ type: "FINALIZED", outcome: "failure", exitCode: 1 }))).toBe(
      "runtime: finalized failure (exit 1)",
    );
    expect(
      eventLine(event({ type: "RETRY", agentId: "implementer", attempt: 1, maxAttempts: 3 })),
    ).toBe("implementer: retry 1/3");
  });

  it("falls back to the type for an event it does not know, and skips a non-event", () => {
    expect(eventLine(event({ type: "SOMETHING_NEW", sender: "supervisor" }))).toBe(
      "supervisor: SOMETHING_NEW",
    );
    expect(eventLine("not json")).toBeUndefined();
    expect(eventLine("{}\n")).toBeUndefined();
  });

  it("prints no terminal escape, however the payload is shaped", () => {
    const awkward = [
      event({
        type: "FINAL_REPORT",
        sender: "implementer",
        payload: { report: "\u001b[31mred\u001b[0m" },
      }),
      event({ type: "UNKNOWN", sender: "x", payload: {} }),
    ];
    for (const raw of awkward) expect(eventLine(raw) ?? "").not.toMatch(ANSI);
  });
});

describe("EventTail", () => {
  it("prints each appended event once, and holds back a partial line", () => {
    const path = join(dir, "conversation.jsonl");
    writeFileSync(path, `${event({ type: "AGENT_REGISTER", sender: "a" })}\n`);
    const tail = new EventTail();
    expect(tail.read(path)).toEqual(["a registered"]);

    // No new bytes: nothing reprinted.
    expect(tail.read(path)).toEqual([]);

    // A partial write yields nothing until its newline arrives.
    writeFileSync(path, `${event({ type: "AGENT_REGISTER", sender: "a" })}\n{"type":"WORK_ORDER"`);
    expect(tail.read(path)).toEqual([]);
    writeFileSync(
      path,
      `${event({ type: "AGENT_REGISTER", sender: "a" })}\n${event({ type: "WORK_ORDER", sender: "supervisor", recipient: "implementer" })}\n`,
    );
    expect(tail.read(path)).toEqual(["supervisor -> implementer: work order"]);
  });

  it("says nothing about a file that does not exist yet", () => {
    expect(new EventTail().read(join(dir, "missing.jsonl"))).toEqual([]);
  });
});

describe("waitingLine", () => {
  it("names the pane, the question, and the key", () => {
    const line = waitingLine("w2E:p1", "This run wants to write files.");
    expect(line).toContain("w2E:p1 is waiting for input");
    expect(line).toContain('"This run wants to write files."');
    expect(line).toContain("press Enter there");
    expect(line).toContain("herdr pane send-keys w2E:p1 Enter");
    expect(line).not.toMatch(ANSI);
  });
});

describe("questionInPane", () => {
  it("reads the question above the Yes choice", () => {
    const pane = [
      " write ~/x/run-details/plan.md",
      "",
      "────────────────────────────────",
      "",
      " This run wants to write files.",
      " write /Users/afshin/x/plan.md",
      "",
      " → Yes",
      "   No",
    ].join("\n");
    expect(questionInPane(pane)).toBe("This run wants to write files.");
  });

  it("reports nothing when no confirmation is on screen", () => {
    expect(questionInPane(" Thinking...\n\n── ⠹ Working ──")).toBeUndefined();
  });
});
