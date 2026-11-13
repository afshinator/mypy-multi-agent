/**
 * The run stage's one-line-per-step timeline, rendered from the three logs the
 * runtime and peers append live — conversation.jsonl, tool-calls.jsonl,
 * spans.jsonl. The prepare stage already renders its own `.trace.md`; this is
 * the run's equivalent, with a line number on every line so a reader can point
 * at one, and a footer that points back at them.
 *
 * Turns are bracketed from conversation frames (a WORK_ORDER opens a turn, the
 * peer's FINAL_REPORT closes it), so the bracket streams live rather than
 * waiting on the peer.turn span, which is only flushed when the turn ends.
 * spans.jsonl supplies the two things conversation does not: when the run
 * started, and when the gate's validation command ran.
 */
import { readFileSync } from "node:fs";
import { parseJsonl } from "../../shared/parse-jsonl";
import { firstSentence } from "./progress";

/** 12-hour wall clock with seconds: "10:00 am (34s)". */
export const clock12 = (ms: number): string => {
  const d = new Date(ms);
  const hour = d.getHours() % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${hour}:${min} ${d.getHours() < 12 ? "am" : "pm"} (${sec}s)`;
};

/** Human duration: "<1 sec", "1.7 sec", "10 sec", "1 min 33 sec". */
export const durHuman = (ms: number): string => {
  if (ms < 1000) return "<1 sec";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} sec`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} sec`;
};

interface Frame {
  timestamp?: unknown;
  type?: unknown;
  sender?: unknown;
  recipient?: unknown;
  payload?: Record<string, unknown>;
}

interface ToolCall {
  timestamp: number;
  agentId: string;
  toolName: string;
  args?: unknown;
  isError?: boolean;
  durationMs?: number;
  error?: string;
}

interface Span {
  name?: unknown;
  start_time?: unknown;
  end_time?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** A tool call's subject: the path/pattern/command it names, clipped to one line. */
const clip = (s: string, n = 56): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

function toolSubject(tool: ToolCall): string {
  const a = tool.args as { path?: unknown; pattern?: unknown; command?: unknown } | undefined;
  if (a?.path !== undefined) return clip(str(a.path).split("/").pop() ?? str(a.path));
  if (a?.pattern !== undefined) return clip(str(a.pattern));
  if (a?.command !== undefined) {
    return clip((str(a.command).split("\n")[0] ?? "").replace(/\s+/g, " ").trim());
  }
  return "";
}

type Item =
  | { at: number; pri: number; kind: "run-start" }
  | { at: number; pri: number; kind: "frame"; frame: Frame }
  | { at: number; pri: number; kind: "tool"; tool: ToolCall }
  | { at: number; pri: number; kind: "val-start" }
  | { at: number; pri: number; kind: "val-end"; ms: number };

function collect(frames: Frame[], tools: ToolCall[], spans: Span[]): Item[] {
  const out: Item[] = [];
  for (const f of frames) {
    const at = num(f.timestamp);
    if (at !== undefined) out.push({ at, pri: 2, kind: "frame", frame: f });
  }
  for (const t of tools) out.push({ at: t.timestamp, pri: 3, kind: "tool", tool: t });
  for (const s of spans) {
    const start = num(s.start_time);
    const end = num(s.end_time);
    if (s.name === "run" && start !== undefined) out.push({ at: start, pri: 0, kind: "run-start" });
    if (s.name === "validation.command") {
      if (start !== undefined) out.push({ at: start, pri: 0, kind: "val-start" });
      if (end !== undefined && start !== undefined)
        out.push({ at: end, pri: 4, kind: "val-end", ms: end - start });
    }
  }
  return out;
}

export interface RenderedRunLog {
  lines: string[];
  summary: string[];
}

/** Render the merged logs into numbered lines plus a footer that points at them. */
export function renderRunLog(
  conversation: Frame[],
  tools: ToolCall[],
  spans: Span[],
  ticket?: number,
): RenderedRunLog {
  const sorted = collect(conversation, tools, spans).sort((a, b) => a.at - b.at || a.pri - b.pri);

  const lines: string[] = [];
  const errors: { line: number; text: string }[] = [];
  let longestTool: { line: number; ms: number; text: string } | undefined;
  let longestTurn: { begin: number; end: number; ms: number; agent: string } | undefined;
  let outcome = "";

  let lineNo = 0;
  let currentAgent: string | undefined;
  let turnStartMs: number | undefined;
  let turnBeginLine: number | undefined;

  const emit = (at: number, indent: string, text: string): number => {
    lineNo += 1;
    lines.push(`${String(lineNo).padStart(2)}  ${clock12(at)}  ${indent}${text}`);
    return lineNo;
  };

  const indent = (): string => (currentAgent === undefined ? "" : "    ");

  for (const item of sorted) {
    switch (item.kind) {
      case "run-start":
        emit(item.at, "", "▸ run starts");
        break;
      case "frame": {
        const f = item.frame;
        const sender = str(f.sender);
        const payload = f.payload ?? {};
        switch (f.type) {
          case "AGENT_REGISTER":
            emit(item.at, "", `· ${sender} registered (${str(payload.model).split("/").pop()})`);
            break;
          case "WORK_ORDER": {
            const recipient = str(f.recipient);
            const task = str(payload.taskId);
            const action = str(payload.action);
            const summary = action === "" ? "" : firstSentence(action);
            const num = ticket === undefined ? "" : `#${ticket} `;
            emit(
              item.at,
              "",
              `${num}▸ supervisor → ${recipient}: work order ${task}${summary === "" ? "" : ` — ${summary}`}`,
            );
            turnBeginLine = emit(item.at, "", `▸ ${recipient} turn begins`);
            currentAgent = recipient;
            turnStartMs = item.at;
            break;
          }
          case "INTENT_TO_MODIFY":
            emit(item.at, indent(), `· intent to modify ${str(payload.intent)}`);
            break;
          case "FINAL_REPORT": {
            emit(item.at, indent(), `· FINAL_REPORT (${str(payload.report).length} chars)`);
            if (
              currentAgent !== undefined &&
              turnStartMs !== undefined &&
              turnBeginLine !== undefined
            ) {
              const ms = item.at - turnStartMs;
              const endLine = emit(item.at, "", `▸ ${currentAgent} turn ends (${durHuman(ms)})`);
              if (longestTurn === undefined || ms > longestTurn.ms) {
                longestTurn = { begin: turnBeginLine, end: endLine, ms, agent: currentAgent };
              }
            }
            currentAgent = undefined;
            turnStartMs = undefined;
            turnBeginLine = undefined;
            break;
          }
          case "FINALIZED": {
            const top = f as unknown as Record<string, unknown>;
            const oc = str(top.outcome ?? payload.outcome);
            const exit = num(top.exitCode ?? payload.exitCode);
            outcome = oc;
            emit(
              item.at,
              "",
              `✔ finalized ${oc === "" ? "?" : oc}${exit === undefined ? "" : ` (exit ${exit})`}`,
            );
            break;
          }
          case "ERROR": {
            const top = f as unknown as Record<string, unknown>;
            const term = str(top.term);
            const detail = str(top.detail);
            emit(
              item.at,
              "",
              `⚠ runtime: ${str(top.event) === "" ? "error" : str(top.event)}${term === "" ? "" : ` ${term}`}${detail === "" ? "" : ` (${detail})`}`,
            );
            break;
          }
          case "RETRY": {
            const top = f as unknown as Record<string, unknown>;
            emit(
              item.at,
              "",
              `· ${str(top.agentId ?? f.sender)}: retry ${num(top.attempt) ?? "?"}/${num(top.maxAttempts) ?? "?"}`,
            );
            break;
          }
          default:
            break;
        }
        break;
      }
      case "tool": {
        const t = item.tool;
        const dur = t.durationMs === undefined ? "" : ` (${durHuman(t.durationMs)})`;
        const err = t.isError === true ? `  ⚠ ${t.error ?? "failed"}` : "";
        const subject = toolSubject(t);
        const line = emit(
          item.at,
          indent(),
          `${t.toolName}${subject === "" ? "" : ` ${subject}`}${dur}${err}`,
        );
        if (t.isError === true) errors.push({ line, text: t.error ?? "failed" });
        if (
          t.durationMs !== undefined &&
          (longestTool === undefined || t.durationMs > longestTool.ms)
        ) {
          longestTool = {
            line,
            ms: t.durationMs,
            text: `${t.toolName}${subject === "" ? "" : ` ${subject}`}`,
          };
        }
        break;
      }
      case "val-start":
        emit(item.at, "", "▸ validation begins");
        break;
      case "val-end":
        emit(item.at, "", `▸ validation ends (${durHuman(item.ms)})`);
        break;
    }
  }

  const summary: string[] = [];
  if (longestTurn !== undefined) {
    const range =
      longestTurn.begin === longestTurn.end
        ? `line ${longestTurn.begin}`
        : `lines ${longestTurn.begin}–${longestTurn.end}`;
    summary.push(
      `longest event: ${longestTurn.agent} turn — ${range} (${durHuman(longestTurn.ms)})`,
    );
  }
  if (longestTool !== undefined) {
    summary.push(
      `longest tool: ${longestTool.text} — line ${longestTool.line} (${durHuman(longestTool.ms)})`,
    );
  }
  if (errors.length > 0) {
    const recovery = outcome === "success" ? "all recovered" : "some unresolved";
    summary.push(
      `errors: ${errors.length} — ${errors.map((e) => `line ${e.line}`).join(", ")} · ${recovery}`,
    );
    for (const e of errors) summary.push(`  · line ${e.line}: ${e.text}`);
  } else {
    summary.push("errors: 0");
  }

  return { lines, summary };
}

/** Read one run's three logs and render the full timeline. */
export function renderRunLogFiles(runDetailsDir: string, ticket?: number): RenderedRunLog {
  const read = (name: string): unknown[] => {
    try {
      return parseJsonl(readFileSync(`${runDetailsDir}/${name}`, "utf8")) as unknown[];
    } catch {
      return [];
    }
  };
  return renderRunLog(
    read("conversation.jsonl") as Frame[],
    read("tool-calls.jsonl") as ToolCall[],
    read("spans.jsonl") as Span[],
    ticket,
  );
}

/** Incremental renderer for a live run: re-reads the three logs and emits only new lines. */
export class RunLogTail {
  private printed = 0;

  constructor(
    private readonly runDetailsDir: string,
    private readonly ticket?: number,
  ) {}

  poll(): string[] {
    const { lines } = renderRunLogFiles(this.runDetailsDir, this.ticket);
    const fresh = lines.slice(this.printed);
    this.printed = lines.length;
    return fresh;
  }

  footer(): string[] {
    return renderRunLogFiles(this.runDetailsDir, this.ticket).summary;
  }
}
