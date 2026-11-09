import { execFileSync } from "node:child_process";
import { resolve, sep } from "node:path";

export type ToolCallEvent = { toolName: string; input: Record<string, unknown> };
export type InputEvent = { text: string };
export type Ctx = {
  hasUI: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
  /** The checkout's branch and root. Production leaves them out and git is asked (#458). */
  branch?: string;
  repoRoot?: string;
  /** The transcript. Production leaves it in, and the reconcile line is read from it (#458). */
  sessionManager?: { getBranch?: () => unknown[] };
};
export type Api = {
  on(event: "tool_call", handler: (e: ToolCallEvent, ctx: Ctx) => Promise<unknown>): void;
  on(event: "input", handler: (e: InputEvent) => void): void;
};

type WriteMode = "answer" | "action" | "ambiguous";

// shortcut: a write hidden inside an unlisted interpreter's quoted payload is not detected; add
// that interpreter here if an answer-only turn is observed writing through it.
const INTERPRETER_HEADS = /^(?:bash|sh|zsh|dash|ksh|eval|exec|xargs|env|sudo|nohup|time)$/;
const WRITE_WORDS = [
  /\btee\b/,
  /\bsed\s+-i/,
  /\bgit\s+(add|commit|push|apply|am|stash|reset|checkout|restore|merge|rebase|clean|rm|mv|tag|init|clone|pull|fetch)\b/,
  /\b(rm|rmdir|mv|cp|mkdir|touch|truncate|ln|shred)\b/,
  /\bnpm\s+(install|uninstall|update|ci|publish|link)\b/,
];
// A write only when the word is the command itself, so a path or a search term (`x.patch`,
// `rg patch docs/`) reads as data. `patch` takes its input on stdin, so head is where it sits.
const HEAD_WRITES = /^(?:patch|unzip)$/;
// A redirect that survives quote stripping: `echo hi > out.txt` writes, `echo 'a > b'` does not.
const REDIRECT = /(?<![0-9&])>(?!&)/;
/** Verbs that ask for work on files. Only these license a write. */
const WRITE_VERBS =
  "fix|implement|edit|change|update|create|write|add|remove|delete|refactor|commit|push|apply|land|run|execute|build|make";
/** Verbs that ask for an answer. They read, so a turn that only reads must not write. */
const READ_VERBS =
  "review|verify|check|inspect|research|investigate|analy[sz]e|look into|take a look";
const QUESTION_START =
  /^(what|why|how|where|when|which|who|is|are|does|do|should|would|tell me|explain|describe|summari[sz]e|outline|estimate)\b/i;
const WRITE_ACTION = new RegExp(
  String.raw`^(?:please\s+|go ahead(?: and)?\s+)?(?:${WRITE_VERBS})\b`,
  "i",
);
const REQUESTED_WRITE = new RegExp(
  String.raw`^(?:can|could|would|will)\s+you\b[\s\S]*\b(?:${WRITE_VERBS})\b`,
  "i",
);
const COMPOUND_WRITE = new RegExp(String.raw`\b(?:and|then)\b[\s\S]*\b(?:${WRITE_VERBS})\b`, "i");
const READ_ACTION = new RegExp(
  String.raw`^(?:please\s+|go ahead(?: and)?\s+)?(?:${READ_VERBS})\b`,
  "i",
);
/** Authorises the work without naming a verb: "verify it, then go ahead". */
const AUTHORISE = /\b(?:go ahead|do it|proceed)\b/i;

/** Split on `&&`, `||`, `;`, `|` and newlines, ignoring separators inside quotes. */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? "";
    if (quote !== "") {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = ch === "&" || ch === "|" ? command[i + 1] : undefined;
    if (ch === ";" || ch === "\n" || (ch === "|" && pair !== "|") || (ch === "&" && pair === "&")) {
      out.push(current);
      current = "";
      if (ch === "&" && pair === "&") i += 1;
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** The same text with quoted regions removed, so a word inside a string is data, not a command. */ function unquoted(
  text: string,
): string {
  let out = "";
  let quote = "";
  for (const ch of text) {
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

export function bashWrites(command: string): boolean {
  const cleaned = command.replace(/\d?>&\d/g, "").replace(/>>?\s*\/dev\/null/g, "");
  for (const segment of segments(cleaned)) {
    const head = segment.trim().split(/\s+/)[0] ?? "";
    // An interpreter runs its quoted payload, so only there do the words inside quotes count.
    // Everywhere else they are data: `bun -e '… rm -rf x'` prints, it does not remove.
    const text = INTERPRETER_HEADS.test(head) ? segment : unquoted(segment);
    if (REDIRECT.test(text) || HEAD_WRITES.test(head) || WRITE_WORDS.some((re) => re.test(text)))
      return true;
  }
  return false;
}

export function writeMode(text: string): WriteMode {
  const input = text.trim();
  // A user-invoked skill is the user's request for that skill's work, which writes.
  if (/^<skill\b/.test(input)) return "action";
  // A request for work on files, in any shape: "can you fix this?", "go ahead and land it".
  if (WRITE_ACTION.test(input) || REQUESTED_WRITE.test(input)) return "action";
  // A question asks for an answer whatever verb it opens with ("verify this for me …?").
  if (input.endsWith("?")) return "answer";
  // An explicit "go ahead" authorises the work even when the verb it follows was a read.
  if (AUTHORISE.test(input)) return "action";
  // A write asked for beside a read still counts: "review this diff and then fix it".
  if (COMPOUND_WRITE.test(input)) return "action";
  // "verify the claim" and "review this diff" are questions in essence: they read, so the turn
  // is answered and a write in it is refused.
  if (READ_ACTION.test(input)) return "answer";
  if (QUESTION_START.test(input)) return "answer";
  return "ambiguous";
}

/**
 * The reconcile contract, in ponytail's own words: one line names the smallest complete change, one
 * names what is left out. A turn that has said neither has not reconciled, whatever it decided to
 * itself (#458).
 */
const SMALLEST = /^\s*smallest complete change:/im;
const SKIPPED = /^\s*skipped:/im;

export function reconciled(text: string | undefined): boolean {
  return text !== undefined && SMALLEST.test(text) && SKIPPED.test(text);
}

/** The text of the last assistant message, or undefined when the turn has written none. */
export function lastAssistantText(entries: unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { message?: { role?: string; content?: unknown } } | undefined;
    const message = entry?.message;
    if (message?.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    return content
      .map((block) =>
        (block as { type?: string }).type === "text"
          ? String((block as { text?: string }).text ?? "")
          : "",
      )
      .join("\n");
  }
  return undefined;
}

/**
 * A file write inside the checkout while HEAD is `main` has no branch to land on: the work sits on
 * the protected branch until someone moves it. Refused before the first edit, not at commit (#458).
 * A path outside the checkout is somebody else's file (a scratch file under /tmp) and is left be.
 */
export function onMain(input: { path: string; branch?: string; repoRoot?: string }): boolean {
  if (input.branch !== "main" || input.repoRoot === undefined || input.path === "") return false;
  return resolve(input.path).startsWith(`${resolve(input.repoRoot)}${sep}`);
}

/** The checkout's branch and root, read from git; empty outside a repo, which gates nothing. */
function checkoutState(): Pick<Ctx, "branch" | "repoRoot"> {
  try {
    const git = (args: string[]): string =>
      execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return {
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      repoRoot: git(["rev-parse", "--show-toplevel"]),
    };
  } catch {
    return {};
  }
}

export default function (pi: Api) {
  let mode: WriteMode = "ambiguous";
  let reconciledThisTurn = false;

  pi.on("input", (event) => {
    mode = writeMode(event.text);
    reconciledThisTurn = false;
  });

  pi.on("tool_call", async (event, ctx: Ctx) => {
    const isFileWrite = event.toolName === "edit" || event.toolName === "write";
    const command = typeof event.input.command === "string" ? event.input.command : "";
    const isBashWrite = event.toolName === "bash" && bashWrites(command);
    if (!isFileWrite && !isBashWrite) return;
    // A batch run declares itself unattended: no human can answer, so asking would hold the
    // whole ticket until its deadline (#415).
    if (process.env.MYPY_UNATTENDED === "1") return;
    // The branch check runs before the mode check: a licensed write is still the wrong write on
    // `main`. Only edit/write are gated; a bash write on `main` is caught by the commit and land
    // hooks, which refuse with the same remedy.
    const state =
      ctx.branch === undefined ? checkoutState() : { branch: ctx.branch, repoRoot: ctx.repoRoot };
    if (isFileWrite && onMain({ path: String(event.input.path ?? ""), ...state })) {
      return {
        block: true,
        reason:
          "Write blocked: HEAD is main, so there is no branch to land on. " +
          "Cut one first: git switch -c task/<name> origin/main.",
      };
    }
    // Reconciling is a judgement, but stating it is not: the first write of a turn needs the two
    // lines in the transcript, so the reasoning is on the record before the code is (#458).
    if (isFileWrite && !reconciledThisTurn) {
      const transcript = ctx.sessionManager?.getBranch?.() ?? [];
      if (!reconciled(lastAssistantText(transcript))) {
        return {
          block: true,
          reason:
            "Write blocked: state the reconcile line before the first write. " +
            "Two lines, in this message or the one before it: " +
            "'Smallest complete change: <the change>' and 'Skipped: <what you leave out>'.",
        };
      }
      reconciledThisTurn = true;
    }
    if (mode === "action") return;

    const what = isFileWrite
      ? `${event.toolName} ${String(event.input.path ?? "")}`
      : `bash: ${(command.split("\n")[0] ?? "").slice(0, 120)}`;
    // No dialog: a prompt stalls the turn until a human notices it. Refuse instead, and let the
    // reply carry the request in words, which the user can answer in words.
    const because =
      mode === "answer"
        ? "on a request that asked for an answer"
        : "without an explicit instruction";
    return {
      block: true,
      reason: `Write blocked ${because}: ${what}. State what you would change and wait for the user's word.`,
    };
  });
}
