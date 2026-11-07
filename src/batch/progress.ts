/**
 * What `run` prints while it waits (#415).
 *
 * A batch takes minutes and happens in another window: without these lines the terminal
 * shows nothing from launch to verdict, and a supervisor waiting on a keystroke looks
 * exactly like one that is thinking. Every line is derived from a file or a herdr state
 * that already exists — no line is printed for something nobody recorded.
 */
import { readFileSync } from "node:fs";

export type Progress = (line: string) => void;

// Built from a code point so the source carries no literal escape: a transcript can.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

/** The block printed before the run waits: what it will do, where, and until when. */
export function startLines(input: {
  batch: string;
  ticket: number;
  slug: string;
  worktree: string;
  base: string;
  paneId: string;
  deadline: number;
}): string[] {
  return [
    `${input.batch}  #${input.ticket}  ${input.slug}`,
    `  worktree ${input.worktree}  branch task/${input.slug}  base ${input.base}`,
    `  supervisor pane ${input.paneId} — watch: herdr pane read ${input.paneId}`,
    `  deadline ${clock(input.deadline)}`,
    "",
  ];
}

/** One line for one `conversation.jsonl` event; `undefined` for a line that is not an event. */
export function eventLine(raw: string): string | undefined {
  let event: {
    type?: unknown;
    sender?: unknown;
    recipient?: unknown;
    timestamp?: unknown;
    payload?: unknown;
  };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    return undefined;
  }
  if (typeof event.type !== "string") return undefined;
  const when = typeof event.timestamp === "number" ? `${clock(event.timestamp)} ` : "";
  const sender = typeof event.sender === "string" ? event.sender : "?";
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const report = typeof payload.report === "string" ? payload.report : "";
  const line = ((): string => {
    switch (event.type) {
      case "AGENT_REGISTER":
        return `${when}${sender} registered${typeof payload.model === "string" ? ` (${payload.model})` : ""}`;
      case "WORK_ORDER":
        return `${when}${sender} -> ${typeof event.recipient === "string" ? event.recipient : "?"}: work order ${typeof payload.taskId === "string" ? payload.taskId : ""}`;
      case "INTENT_TO_MODIFY":
        return `${when}${sender}: intent to modify ${typeof payload.intent === "string" ? payload.intent : ""}`;
      case "FINAL_REPORT": {
        // A peer reports markdown; the line is a headline, so only the emphasis goes.
        const headline = report
          .split("\n")[0]
          ?.replace(/\*\*|`/g, "")
          .replace(/^\s*[*_]\s*/, "")
          .trim()
          .slice(0, 100);
        return `${when}${sender}: FINAL_REPORT ${headline ?? ""}`;
      }
      default:
        return `${when}${sender}: ${event.type}`;
    }
  })();
  // A transcript can carry escapes; the terminal this prints into must not interpret them.
  return ANSI_ESCAPE ? line.replace(ANSI_ESCAPE, "").trimEnd() : line.trimEnd();
}

/** The line a human needs when the run cannot go on without them. */
export function waitingLine(paneId: string, question: string): string {
  return `${clock(Date.now())} ${paneId} is waiting for input: "${question}" — press Enter there (herdr pane send-keys ${paneId} Enter)`;
}

/**
 * Incremental reader for `conversation.jsonl`: one line per event appended since the last
 * read, so a poll every few seconds never reprints the transcript. A partial last line is
 * left for the next read.
 */
export class EventTail {
  private offset = 0;
  private carry = "";

  read(path: string): string[] {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    if (text.length <= this.offset) return [];
    const fresh = this.carry + text.slice(this.offset);
    this.offset = text.length;
    const lines = fresh.split("\n");
    this.carry = lines.pop() ?? "";
    return lines.map(eventLine).filter((line): line is string => line !== undefined);
  }
}

/**
 * The question a pane is waiting on, read from the bottom of a pi transcript: the line
 * above a `→ Yes` choice, ending in a full stop or question mark. `undefined` when the
 * pane is not showing a confirmation.
 */
export function questionInPane(text: string): string | undefined {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  let choice = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*→\s*Yes\s*$/.test(lines[i] ?? "")) {
      choice = i;
      break;
    }
  }
  if (choice === -1) return undefined;
  for (let i = choice - 1; i >= 0 && i > choice - 20; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line === "") continue;
    if (line.endsWith(".") || line.endsWith("?")) return line.slice(0, 120);
  }
  return undefined;
}
