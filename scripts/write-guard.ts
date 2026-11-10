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

// Shells and wrappers: their quoted payload is run, so write words inside it count.
const INTERPRETER_HEADS = /^(?:bash|sh|zsh|dash|ksh|eval|exec|xargs|env|sudo|nohup|time)$/;
// Code interpreters: a quoted payload is a program, and only the program decides what it writes.
// Every repository edit in the 2026-11-09 session went through `python3 - <<'PY'` and none of them
// was seen as a write, which is how two edits landed on `main` (#491). An inline program is
// therefore a write whatever it contains: opaque means fail closed.
const CODE_INTERPRETERS = /^(?:python(?:3(?:\.\d+)?)?|node|nodejs|bun|deno|ruby|perl|php|Rscript)$/;
const INLINE_PROGRAM = /^(?:-c|-e|-p|-m|--eval|--print|--command|--module|-)$/;
// Wrappers whose own tokens come before the command they run.
const WRAPPERS = /^(?:sudo|env|nohup|time|exec|xargs)$/;
const WRITE_WORDS = [
  /\btee\b/,
  /\bsed\s+-i/,
  /\bgit\s+(add|commit|push|apply|am|stash|reset|checkout|restore|merge|rebase|clean|rm|mv|tag|init|clone|pull|fetch)\b/,
  // A command word stands alone, not inside a flag or a path: `rg -ln` is a flag, `src/cp/x` a path,
  // and matching either made a read-only command look like a write (#491).
  /(?:^|[\s;&|("'`])(rm|rmdir|mv|cp|mkdir|touch|truncate|ln|shred)(?=$|[\s;&|)"'`])/,
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

/**
 * The command a segment runs: the token after any wrapper, its flags and any `VAR=value` prefixes,
 * with the directory dropped. `sudo /usr/bin/python3 -c …` writes exactly what `python3 -c …` writes,
 * and a guard that only knows the bare spelling is #491's hole with a path in front of it.
 */
function resolveCommand(segment: string): { head: string; args: string[] } {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  const base = (token: string): string => token.split("/").pop() ?? token;
  let at = 0;
  // shortcut: a wrapper's flag value is not skipped, so `sudo -u root python3 -c …` still resolves
  // to `root`; add flag arity here if that form is ever observed writing.
  const tokenAt = (index: number): string => tokens[index] ?? "";
  while (at < tokens.length - 1) {
    if (!WRAPPERS.test(base(tokenAt(at))) && !/^\w+=/.test(tokenAt(at))) break;
    at += 1;
    while (tokenAt(at).startsWith("-")) at += 1;
  }
  return { head: base(tokenAt(at)), args: tokens.slice(at + 1) };
}

export function bashWrites(command: string): boolean {
  return bashWriteReason(command) !== undefined;
}

/**
 * Why this command counts as a write, or `undefined` when it does not. The reason is what a refusal
 * shows, because a block that names no cause costs the agent a turn (#491).
 */
export function bashWriteReason(command: string): string | undefined {
  const cleaned = command.replace(/\d?>&\d/g, "").replace(/>>?\s*\/dev\/null/g, "");
  for (const segment of segments(cleaned)) {
    const { head, args } = resolveCommand(segment);
    // An inline program is opaque: it can write anything, so it is a write whatever it says.
    if (CODE_INTERPRETERS.test(head) && args.some((arg) => INLINE_PROGRAM.test(arg))) {
      return `${head} runs an inline program`;
    }
    // A shell interpreter runs its quoted payload, so only there do the words inside quotes count.
    // Everywhere else they are data: `bash -c 'sed -n p x'` reads, it does not write.
    const text = INTERPRETER_HEADS.test(head) ? segment : unquoted(segment);
    if (HEAD_WRITES.test(head)) return head;
    const word =
      WRITE_WORDS.find((re) => re.test(text)) ?? (REDIRECT.test(text) ? REDIRECT : undefined);
    if (word !== undefined) return word.source;
  }
  return undefined;
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
    const why = isBashWrite ? bashWriteReason(command) : undefined;
    const matched = why === undefined ? "" : ` (mode ${mode}, matched: ${why})`;
    // No dialog: a prompt stalls the turn until a human notices it. Refuse instead, and let the
    // reply carry the request in words, which the user can answer in words.
    const because =
      mode === "answer"
        ? "on a request that asked for an answer"
        : "without an explicit instruction";
    return {
      block: true,
      reason: `Write blocked ${because}${matched}: ${what}. State what you would change and wait for the user's word.`,
    };
  });
}
