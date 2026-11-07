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

// shortcut: shell writes through an unlisted interpreter are not detected; add that interpreter
// here if an answer-only turn is observed changing a file through it.
const BASH_WRITES = [
  /\btee\b/,
  /\bsed\s+-i/,
  /\bgit\s+(add|commit|push|apply|am|stash|reset|checkout|restore|merge|rebase|clean|rm|mv|tag|init|clone|pull|fetch)\b/,
  /\b(rm|rmdir|mv|cp|mkdir|touch|truncate|ln|shred)\b/,
  /\bnpm\s+(install|uninstall|update|ci|publish|link)\b/,
  /\b(patch|unzip)\b/,
  /(?<![0-9&])>(?!&)/,
];
const ACTION_WORDS =
  "fix|implement|edit|change|update|create|write|add|remove|delete|refactor|review|verify|check|inspect|research|investigate|analy[sz]e|commit|push|apply|land|run|execute|build|make|look into|take a look";
const QUESTION_START =
  /^(what|why|how|where|when|which|who|is|are|does|do|should|would|tell me|explain|describe|summari[sz]e|outline|estimate|review)\b/i;
const DIRECT_ACTION = new RegExp(
  String.raw`^(?:please\s+|go ahead(?: and)?\s+|(?:${ACTION_WORDS})\b)`,
  "i",
);
const REQUESTED_ACTION_QUESTION = new RegExp(
  String.raw`^(?:can|could|would|will)\s+you\b.*\b(?:${ACTION_WORDS})\b`,
  "i",
);
const COMPOUND_ACTION = new RegExp(String.raw`\b(?:and|then)\b.*\b(?:${ACTION_WORDS})\b`, "i");

export function bashWrites(command: string): boolean {
  const stripped = command.replace(/\d?>&\d/g, "").replace(/>>?\s*\/dev\/null/g, "");
  return BASH_WRITES.some((re) => re.test(stripped));
}

export function writeMode(text: string): WriteMode {
  const input = text.trim();
  if (
    DIRECT_ACTION.test(input) ||
    REQUESTED_ACTION_QUESTION.test(input) ||
    COMPOUND_ACTION.test(input)
  )
    return "action";
  if (QUESTION_START.test(input) || input.endsWith("?")) return "answer";
  return "ambiguous";
}

export default function (pi: Api) {
  let mode: WriteMode = "ambiguous";
  let approved = false;

  pi.on("input", (event) => {
    mode = writeMode(event.text);
    approved = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    const isFileWrite = event.toolName === "edit" || event.toolName === "write";
    const command = typeof event.input.command === "string" ? event.input.command : "";
    const isBashWrite = event.toolName === "bash" && bashWrites(command);
    if (!isFileWrite && !isBashWrite) return;
    // A batch run declares itself unattended: no human can answer, so asking would hold the
    // whole ticket until its deadline (#415).
    if (process.env.MYPY_UNATTENDED === "1") return;
    if (mode === "action" || approved) return;

    const what = isFileWrite
      ? `${event.toolName} ${String(event.input.path ?? "")}`
      : `bash: ${(command.split("\n")[0] ?? "").slice(0, 120)}`;

    if (mode === "answer") {
      return { block: true, reason: `Write blocked on an answer-only request: ${what}` };
    }
    if (!ctx.hasUI) {
      return { block: true, reason: `Write blocked (no confirmation UI available): ${what}` };
    }

    const allow = await ctx.ui.confirm("This run wants to write files.", what);
    if (!allow) {
      return {
        block: true,
        reason: "Write blocked by the user. Answer the question; do not modify files.",
      };
    }
    approved = true;
  });
}
