export type ToolCallEvent = { toolName: string; input: Record<string, unknown> };
export type InputEvent = { text: string };
export type Ctx = {
  hasUI: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
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
  /\b(patch|unzip)\b/,
];
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

/** The same text with quoted regions removed, so a word inside a string is data, not a command. */
function unquoted(text: string): string {
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
    if (REDIRECT.test(text) || WRITE_WORDS.some((re) => re.test(text))) return true;
  }
  return false;
}

export function writeMode(text: string): WriteMode {
  const input = text.trim();
  // A request for work on files, in any shape: "can you fix this?", "go ahead and land it".
  if (WRITE_ACTION.test(input) || REQUESTED_WRITE.test(input)) return "action";
  // A question asks for an answer whatever verb it opens with ("verify this for me …?").
  if (input.endsWith("?")) return "answer";
  // A write asked for beside a read still counts: "review this diff and then fix it".
  if (COMPOUND_WRITE.test(input)) return "action";
  // "verify the claim" and "review this diff" are questions in essence: they read, so the turn
  // is answered and a write in it is refused.
  if (READ_ACTION.test(input)) return "answer";
  if (QUESTION_START.test(input)) return "answer";
  return "ambiguous";
}

export default function (pi: Api) {
  let mode: WriteMode = "ambiguous";

  pi.on("input", (event) => {
    mode = writeMode(event.text);
  });

  pi.on("tool_call", async (event, _ctx: Ctx) => {
    const isFileWrite = event.toolName === "edit" || event.toolName === "write";
    const command = typeof event.input.command === "string" ? event.input.command : "";
    const isBashWrite = event.toolName === "bash" && bashWrites(command);
    if (!isFileWrite && !isBashWrite) return;
    // A batch run declares itself unattended: no human can answer, so asking would hold the
    // whole ticket until its deadline (#415).
    if (process.env.MYPY_UNATTENDED === "1") return;
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
