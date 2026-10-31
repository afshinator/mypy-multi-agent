/**
 * pi extension appending a nearest-match hint to a failed `edit` (issue #138).
 *
 * pi refuses an `oldText` that matches nothing with a message that names no
 * location, so the model re-reads the whole file or rewrites it wholesale: in
 * `jev-c2-closeout` a peer failed three times and then wrote two complete files
 * (run-details/tool-calls.jsonl:87,89,90 then :92,:95). Matching stays pi's —
 * this only adds text to the error, so exact/fuzzy semantics are untouched.
 *
 * Loaded by both hosts: the peers' extensionFactories and the supervisor's
 * extension assembly.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

/** The not-found refusals (`edit-diff.js`); duplicate/empty-text errors are not ours. */
const MISS_ERROR = "Could not find";
const WINDOW = 3;
const MAX_LINE_CHARS = 160;
const MAX_HINT_CHARS = 900;
const MAX_FILE_BYTES = 1_000_000;
/** Fewer shared tokens than this is a coincidence, not a match. */
const MIN_SHARED_TOKENS = 3;

function tokenize(line: string): string[] {
  return line
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");
}

/** Length of the longest run of consecutive tokens two lines share. */
function sharedRun(a: string[], b: string[]): number {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let run = 0;
      while (i + run < a.length && j + run < b.length && a[i + run] === b[j + run]) run++;
      if (run > best) best = run;
    }
  }
  return best;
}

export interface NearestLine {
  /** 0-based index of the closest line. */
  index: number;
  shared: number;
}

/** Closest file line to one line of the refused `oldText`, by shared token run. */
export function nearestLine(fileLines: readonly string[], probe: string): NearestLine | null {
  const probeTokens = tokenize(probe);
  if (probeTokens.length < MIN_SHARED_TOKENS) return null;
  const needed = Math.max(MIN_SHARED_TOKENS, Math.ceil(probeTokens.length / 2));
  let best: NearestLine | null = null;
  for (const [index, line] of fileLines.entries()) {
    const shared = sharedRun(tokenize(line), probeTokens);
    if (shared >= needed && (best === null || shared > best.shared)) best = { index, shared };
  }
  return best;
}

function clip(line: string): string {
  const text = line.trimEnd();
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

/**
 * The hint text for a refused `oldText`, or undefined when no line is close.
 * The longest `oldText` line is the probe: it carries the most signal, and a
 * wrapped line is exactly the drift that produces a miss.
 */
export function formatMissHint(fileText: string, oldText: string): string | undefined {
  const probe = oldText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .reduce((longest, line) => (line.length > longest.length ? line : longest), "");
  if (probe === "") return undefined;
  const fileLines = fileText.split("\n");
  const near = nearestLine(fileLines, probe);
  if (near === null) return undefined;

  const from = Math.max(0, near.index - WINDOW);
  const to = Math.min(fileLines.length - 1, near.index + WINDOW);
  const header = `Nearest match is around line ${near.index + 1} — re-read it, then retry with that exact text:`;
  const rows: string[] = [header];
  let budget = MAX_HINT_CHARS - header.length;
  for (let i = from; i <= to; i++) {
    const marker = i === near.index ? ">" : " ";
    const row = `${marker} ${String(i + 1).padStart(5)} | ${clip(fileLines[i] ?? "")}`;
    if (row.length + 1 > budget) break;
    rows.push(row);
    budget -= row.length + 1;
  }
  return rows.join("\n");
}

function textOf(event: ToolResultEvent): string {
  return event.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
}

/** The refused `oldText`: the one named by `edits[N]` in the error, else the first. */
function refusedOldText(input: Record<string, unknown>, message: string): string | undefined {
  const single = input.oldText;
  if (typeof single === "string") return single;
  const edits = input.edits;
  if (!Array.isArray(edits)) return undefined;
  const named = /edits\[(\d+)\]/u.exec(message);
  const index = named === null ? 0 : Number(named[1]);
  const edit = (edits[index] ?? edits[0]) as { oldText?: unknown } | undefined;
  return typeof edit?.oldText === "string" ? edit.oldText : undefined;
}

async function hintFor(path: unknown, oldText: string | undefined): Promise<string | undefined> {
  if (typeof path !== "string" || path === "" || oldText === undefined) return undefined;
  try {
    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
    const file = await readFile(absolute);
    if (file.byteLength > MAX_FILE_BYTES) return undefined;
    return formatMissHint(file.toString("utf8"), oldText);
  } catch {
    return undefined; // a hint is never worth failing the tool result for
  }
}

export function toolResultHint(): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_result", async (event) => {
      if (!event.isError || event.toolName !== "edit") return undefined;
      const message = textOf(event);
      if (!message.includes(MISS_ERROR)) return undefined;
      const input = event.input;
      const hint = await hintFor(input.path, refusedOldText(input, message));
      if (hint === undefined) return undefined;
      return {
        content: [...event.content, { type: "text" as const, text: hint }],
        ...(event.structuredContent === undefined
          ? {}
          : { structuredContent: event.structuredContent }),
      };
    });
  };
}
