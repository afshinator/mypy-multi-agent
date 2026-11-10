/**
 * Reading the two replies that decide whether a ticket is accepted.
 *
 * Neither reply has a schema: the triage agent answers in markdown sections and the
 * verifier in a fenced JSON block, both fixed by text in
 * docs/explorations/triage-automation/. The acceptance gate is "every verifier row is a
 * match" (design D11), and that sentence is true for an empty set — so every parser here
 * fails closed, and `acceptance` refuses a report with no rows and a block whose rows do
 * not line up one-for-one with the report's.
 */
export interface ClaimRow {
  /** 1-based, in table order — the number the verifier's block refers to. */
  index: number;
  claim: string;
  command: string;
  observed: string;
  /** The cell's first word, lowercased: `true` | `partial` | `false` (#464). */
  verdict: string;
  /** Whatever followed that word, verbatim — the author's reason, which a reader still needs. */
  note?: string;
}

export type TriageVerdict = "run" | "inline" | "no-dod";

export interface TriageReport {
  claims: ClaimRow[];
  /** The table verbatim: the verifier prompt is given text, and re-serializing would drift. */
  claimsText: string;
  /** Bare criterion text; `normalizeDoD` folds the rest (backticks, dashes, links). */
  criteria: string[];
  verdict: TriageVerdict;
  noDod?: { code: string; reason: string };
  /**
   * The criteria came from the issue body, not the reply (#469). The body is the user's own prose,
   * where `rows 3, 7` is not the citation the prompt defines, so the gate does not read it as one.
   */
  criteriaFromBody?: boolean;
  /**
   * The `KIND:` answer: a policy kind. Left unvalidated here; `prepare` accepts only
   * policy kinds and refuses anything else as `kind-invalid`.
   */
  kind?: string;
}

export interface RowVerdict {
  row: number;
  verdict: "match" | "mismatch";
  evidence: string;
  /** The command the verifier ran, copied from the row it was checking (#462). */
  command: string;
  /** That run's exit status; a `match` needs 0 or 1, a broken run exits 2 or more. */
  exit: number;
}

export interface DodVerdict {
  criterion: number;
  verdict: "match" | "mismatch";
  evidence: string;
}

export interface VerifierBlock {
  verdicts: RowVerdict[];
  /** Row numbers named as `could-not-run`; an undecidable row is not a pass. */
  couldNotRun: number[];
  /** DoD-criterion verdicts from the second fenced block; absent when the reply has none. */
  dod?: DodVerdict[];
}

export type Acceptance =
  | { ok: true }
  | { ok: false; code: "unverifiable" | "verifier-mismatch" | "harness-error"; detail: string };

/** `## Name` → its body, keyed by the lowercased name. */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = [];
      out.set((heading[1] ?? "").toLowerCase(), current);
      continue;
    }
    current?.push(line);
  }
  return out;
}

function section(text: string, name: string): string[] {
  const body = sections(text).get(name.toLowerCase());
  if (body === undefined) throw new Error(`triage report has no "## ${name}" section`);
  return body;
}

/**
 * Cells on pipes that are neither backslash-escaped nor inside a code span: a claim's
 * command is usually `rg -n "a|b" x.ts`, and a plain split turns one row into six cells.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell);

  const trimmed = cells.map((c) => c.trim());
  // The row's own leading and trailing pipes produce two empty edge cells.
  if (trimmed[0] === "") trimmed.shift();
  if (trimmed.at(-1) === "") trimmed.pop();
  return trimmed;
}

const SEPARATOR = /^:?-{2,}:?$/;

/** A checkbox bullet, the form `/skill:to-tickets` writes into an issue body. */
const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]\s+(.*)$/;
/** A plain bullet. Half the bodies filed by hand use `- `, and reading it as "no criteria" refused a
 * good ticket as `dod-rejected` — the bullets are the list, exactly as numbered items are (#502). */
const BULLET = /^\s*[-*+]\s+(.*)$/;

/** A cell is usually one code span; keep the text, drop the delimiters. */
function unwrap(cell: string): string {
  const m = /^`([^`]*)`$/.exec(cell);
  return m?.[1] ?? cell;
}

/** Variables every shell provides, so a claim command may read them without assigning them. */
const AMBIENT_VARS = new Set(["HOME", "PATH", "PWD", "SHELL", "TERM", "TMPDIR", "USER"]);

const VAR_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function assignedIn(command: string, name: string): boolean {
  return (
    new RegExp(`\\b${name}=`).test(command) ||
    new RegExp(`\\bfor\\s+${name}\\b`).test(command) ||
    new RegExp(`\\bread\\s+(-\\w+\\s+)*${name}\\b`).test(command)
  );
}

/**
 * A claim command that cannot run as written, so the verifier can only report it as unrun: the
 * agent abbreviated it with prose punctuation, or it reads a variable nothing sets (#401). Static
 * by design — executing it cannot tell a broken command from an absent target (#367).
 */
export function commandFaults(command: string): string[] {
  const faults: string[] = [];
  // `unwrap` strips the delimiters of exactly one span; anything left is a cell that kept its
  // markdown, so the shell would run a substitution instead of the row's command (#463).
  if (command.includes("`")) faults.push("backtick");
  for (const ch of command) {
    if (ch !== "\n" && (ch < " " || ch > "~")) {
      faults.push(`U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
      break;
    }
  }
  for (const m of command.matchAll(VAR_REF)) {
    const name = m[1] ?? m[2] ?? "";
    if (AMBIENT_VARS.has(name.toUpperCase()) || assignedIn(command, name)) continue;
    faults.push(`$${name}`);
  }
  return faults;
}

/**
 * Verbs that destroy or rewrite files. A claim row is model-authored from untrusted ticket text, so
 * the verifier must not be asked to run one of these: the verifier is what executes the row (#483).
 */
const DESTRUCTIVE = new Set([
  "rm",
  "rmdir",
  "mv",
  "dd",
  "chmod",
  "chown",
  "mkfs",
  "shutdown",
  "reboot",
  "kill",
  "killall",
  "pkill",
  "shred",
  "truncate",
]);

/** Programs that run another program, skipped to find the verb a segment really runs. */
const WRAPPERS = new Set(["env", "command", "nice", "timeout", "sudo", "nohup", "time", "exec"]);

/** Paths outside the clone that a legitimate claim may still name. */
const SAFE_PATHS = [/^\/dev\/(null|stdout|stderr)$/, /^\/tmp\//, /^\/var\/folders\//];

/** A download piped into a shell runs whatever it fetched, so the row runs code nobody reviewed. */
const PIPED_INTO_SHELL = /[|]\s*(?:(?:sudo|env)\s+)*(?:sh|bash|zsh|dash|ksh|fish)\b/;

/** The token groups a command runs, split at the separators that start a new command. */
function segments(command: string): string[][] {
  return command
    .split(/[;|&()\n`]+/)
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .filter((t) => t !== ""),
    )
    .filter((tokens) => tokens.length > 0);
}

const isAssignment = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

/** Skip assignments and wrappers to the token that decides what the segment runs. */
function verbOf(tokens: readonly string[]): string {
  let i = 0;
  while (i < tokens.length && (isAssignment(tokens[i] ?? "") || WRAPPERS.has(tokens[i] ?? ""))) i++;
  return tokens[i] ?? "";
}

/** A curl/wget flag that sends data: `-d`, `--data*`, `--json`, `-F`, `--form*`, `-T`, `-X POST`. */
function uploads(tokens: readonly string[]): boolean {
  return tokens.some((token, i) => {
    if (/^(-d|--data.*|--json|-F|--form.*|-T|--upload-file)$/.test(token)) return true;
    return /^(-X|--request)$/.test(token) && /^(POST|PUT|PATCH)$/.test(tokens[i + 1] ?? "");
  });
}

/** The token's path when it points outside the clone, or `undefined` when it is fine. */
function escapes(token: string, cloneRoot: string): string | undefined {
  if (isAssignment(token) || token.startsWith("-")) return undefined;
  const bare = token.replace(/^["']|["']$/g, "");
  if (bare === "~" || bare.startsWith("~/")) return "~";
  if (bare === ".." || bare.startsWith("../")) return "..";
  if (!bare.startsWith("/")) return undefined;
  if (SAFE_PATHS.some((safe) => safe.test(bare))) return undefined;
  return bare === cloneRoot || bare.startsWith(`${cloneRoot}/`) ? undefined : bare;
}

/**
 * Where a claim command would leave the clone or destroy what is in it, as a fault naming the
 * reason (#483). Static and deliberately narrow: it refuses the accidental class before the
 * verifier executes anything, and it does not try to stop deliberate code execution, which needs a
 * sandbox rather than a text rule.
 */
export function commandSafetyFaults(
  commands: readonly string[],
  cloneRoot: string,
): { row: number; fault: string }[] {
  const faults: { row: number; fault: string }[] = [];
  commands.forEach((command, i) => {
    const row = i + 1;
    if (PIPED_INTO_SHELL.test(command)) {
      faults.push({ row, fault: "pipes a download into a shell, which runs code nobody reviewed" });
      return;
    }
    for (const tokens of segments(command)) {
      const verb = verbOf(tokens);
      if (DESTRUCTIVE.has(verb)) {
        faults.push({ row, fault: `runs ${verb}, which destroys or rewrites files` });
        return;
      }
      if ((verb === "curl" || verb === "wget") && uploads(tokens)) {
        faults.push({ row, fault: `${verb} sends data out of the clone` });
        return;
      }
      for (const token of tokens) {
        const path = escapes(token, cloneRoot);
        if (path !== undefined) {
          faults.push({ row, fault: `names ${path}, which is outside the clone` });
          return;
        }
      }
    }
  });
  return faults;
}

/** The faulted rows of a report, 1-based in table order — the numbering the verifier block uses. */
export function dialectFaults(claims: readonly ClaimRow[]): { row: number; faults: string[] }[] {
  return claims
    .map((c) => ({ row: c.index, faults: commandFaults(c.command) }))
    .filter((f) => f.faults.length > 0);
}

/** The three words the report format defines for a verdict; anything else is not a verdict. */
const VERDICT_WORDS = new Set(["true", "partial", "false"]);

/** A cell the report needs: an empty one records nothing, so the row cannot be checked (#464). */
function requiredCell(cells: readonly string[], i: number, name: string, row: number): string {
  const value = unwrap(cells[i] ?? "").trim();
  if (value === "") throw new Error(`claim row ${row}: the ${name} cell is empty`);
  return value;
}

/**
 * `true (current code; ...)` is one verdict with a reason: the first word decides, the rest is
 * kept as the note so the repair prompt still shows the author's reasoning (#464).
 */
function parseVerdictCell(cell: string, row: number): { verdict: string; note: string } {
  const m = /^(\S+)([\s\S]*)$/.exec(cell.trim());
  const word = (m?.[1] ?? "").toLowerCase();
  if (!VERDICT_WORDS.has(word)) {
    throw new Error(`claim row ${row}: verdict \`${m?.[1] ?? ""}\` is not true, partial or false`);
  }
  return { verdict: word, note: m?.[2] ?? "" };
}

function parseClaims(body: readonly string[]): { claims: ClaimRow[]; text: string } {
  const table = body.filter((line) => /^\s*\|.*\|\s*$/.test(line));
  const rows = table
    .map(splitRow)
    .filter((cells) => cells.length > 0 && !cells.every((c) => SEPARATOR.test(c) || c === ""));

  const header = rows.shift();
  if (header === undefined) throw new Error("triage report has no claim rows");
  // A triage agent sometimes prepends a row-number column (header first cell `#`).
  // Drop it from every data row so the positional claim | command | observed |
  // verdict mapping still holds.
  if (header[0] === "#") {
    for (const row of rows) row.shift();
  }
  const ragged = rows.findIndex((cells) => cells.length !== 4);
  if (ragged !== -1) {
    throw new Error(
      `claim row ${ragged + 1} has ${rows[ragged]?.length ?? 0} cells, expected 4 (claim | command | observed | verdict)`,
    );
  }
  const claims = rows.map((cells, i) => ({
    index: i + 1,
    claim: requiredCell(cells, 0, "claim", i + 1),
    command: requiredCell(cells, 1, "command", i + 1),
    observed: requiredCell(cells, 2, "observed", i + 1),
    ...parseVerdictCell(unwrap(cells[3] ?? ""), i + 1),
  }));
  if (claims.length === 0) throw new Error("triage report has no claim rows");
  return { claims, text: table.join("\n") };
}

function parseCriteria(body: readonly string[]): {
  criteria: string[];
  noDod?: { code: string; reason: string };
} {
  const stop = /^No DoD:\s*(N[1-5])\s*[:\u2014-]?\s*(.*)$/;
  for (const line of body) {
    const m = stop.exec(line.trim());
    if (m) return { criteria: [], noDod: { code: m[1] ?? "", reason: (m[2] ?? "").trim() } };
  }

  const criteria: string[] = [];
  let open = -1;
  for (const line of body) {
    const item = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line) ?? CHECKBOX.exec(line) ?? BULLET.exec(line);
    if (item) {
      criteria.push((item[1] ?? "").trim());
      open = criteria.length - 1;
      continue;
    }
    if (line.trim() === "") {
      open = -1;
      continue;
    }
    // A wrapped criterion continues the previous item; unindented prose is not a criterion.
    if (open >= 0 && /^\s{2,}\S/.test(line)) {
      criteria[open] = `${criteria[open] ?? ""} ${line.trim()}`;
    }
  }
  return { criteria };
}

function parseVerdict(body: readonly string[]): TriageVerdict {
  const text = body.join(" ").replace(/`/g, "");
  // First mention wins, so "run, not inline" is a run.
  const found = /\b(run|inline|no DoD)\b/i.exec(text)?.[1]?.toLowerCase();
  if (found === "run" || found === "inline") return found;
  if (found === "no dod") return "no-dod";
  throw new Error('triage report "## Verdict" names neither run, inline nor no DoD');
}

/**
 * The criteria an issue body states under its Definition of Done heading, or `undefined` when it
 * states none. The body owns the DoD (#469); `normalizeDoD` folds what this returns.
 */
export function definitionOfDone(text: string): string[] | undefined {
  // A fenced example in the body can contain a heading at line start; only prose headings count.
  const byHeading = sections(text.replace(/```[\s\S]*?```/g, ""));
  // `/skill:to-tickets` names this section "Acceptance criteria"; the glossary records that a
  // ticket's acceptance criteria are its DoD, so both headings mean the same list (#469).
  const body = byHeading.get("definition of done") ?? byHeading.get("acceptance criteria");
  if (body === undefined) return undefined;
  return parseCriteria(body).criteria;
}

export function parseTriageReport(text: string): TriageReport {
  const { claims, text: claimsText } = parseClaims(section(text, "Claim checks"));
  const { criteria, noDod } = parseCriteria(section(text, "Definition of Done"));
  const verdict = parseVerdict(section(text, "Verdict"));
  const report: TriageReport = { claims, claimsText, criteria, verdict };
  if (noDod !== undefined) report.noDod = noDod;
  const kind = /\bKIND:\s*`?([a-z][a-z0-9-]*)`?/i.exec(text)?.[1];
  if (kind !== undefined) report.kind = kind.toLowerCase();
  return report;
}

const FENCE = /```json\s*\n([\s\S]*?)```/g;

/** Where the verifier's reasoning lands on disk; the refusal names it so a reader can go there. */
export const VERDICT_EVIDENCE = "verdicts.json";
/** The same for the re-verification of flagged rows alone (#388). */
export const REVERDICT_EVIDENCE = "reverdicts.json";
/** The merged block that decides a repaired ticket (#460). */
export const MERGED_EVIDENCE = "merged.json";

type Entry = { verdict: "match" | "mismatch"; evidence: string };

/** What the reply says about the run itself, for a claim row (#462). */
type RunFields = { command: string; exit: number };

/**
 * One parser for both verifier blocks: they differ only in the key that numbers the entry
 * (`row` for the claim table, `criterion` for the DoD). A claim-row entry also carries the
 * command it ran and that run's exit status (#462); a DoD criterion is not a command, so it
 * carries neither. Fails closed on any other shape.
 */
function parseVerdicts<K extends string>(
  jsonText: string,
  key: K,
  label: string,
): (Entry & Record<K, number> & Partial<RunFields>)[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`${label} is not JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} is not an array of verdicts`);
  return parsed.map((entry, i) => {
    const e = entry as Record<string, unknown> | null;
    const ok =
      e !== null &&
      typeof e === "object" &&
      Number.isInteger(e[key]) &&
      (e.verdict === "match" || e.verdict === "mismatch") &&
      typeof e.evidence === "string";
    if (!ok) throw new Error(`${label} entry ${i + 1} is not {${key}, verdict, evidence}`);
    const base = {
      [key]: e[key] as number,
      verdict: e.verdict as "match" | "mismatch",
      evidence: e.evidence as string,
    } as Entry & Record<K, number>;
    if (key === "criterion") return base;
    // A claim row without the run is a reply that cannot be checked: the gate needs both to
    // know the command ran as written (#462).
    if (typeof e.command !== "string" || !Number.isInteger(e.exit)) {
      throw new Error(`${label} entry ${i + 1} is not {${key}, verdict, evidence, command, exit}`);
    }
    return { ...base, command: e.command, exit: e.exit as number };
  });
}

export function parseVerifierBlock(text: string): VerifierBlock {
  const fences = [...text.matchAll(FENCE)];
  if (fences.length === 0) throw new Error("verifier reply has no fenced ```json block");

  const verdicts = parseVerdicts(fences[0]?.[1] ?? "", "row", "verifier block") as RowVerdict[];

  const tail = /^could-not-run:\s*(.*)$/m.exec(text);
  if (tail === null) throw new Error("verifier reply has no could-not-run line");
  const named = (tail[1] ?? "").trim();
  const couldNotRun = /^none$/i.test(named)
    ? []
    : [...named.matchAll(/\d+/g)].map((m) => Number(m[0]));

  const dod =
    fences.length >= 2
      ? (parseVerdicts(fences[1]?.[1] ?? "", "criterion", "verifier DoD block") as DodVerdict[])
      : undefined;

  return { verdicts, couldNotRun, dod };
}

/** What a block's entries are called in a refusal: one name for the claims, one for the DoD. */
interface Naming {
  /** Prefix on the entry noun, e.g. `DoD `. */
  prefix: string;
  singular: string;
  plural: string;
}

const ROWS: Naming = { prefix: "", singular: "row", plural: "rows" };
const CRITERIA: Naming = { prefix: "DoD ", singular: "criterion", plural: "criteria" };

/**
 * The gate's one-for-one rule, written once: as many entries as the report has lines, and
 * each entry numbered 1..n in order. The DoD runs the same rule as the claim table (#291).
 */
function lineUp<T>(
  entries: readonly T[],
  expected: number,
  name: Naming,
  keyOf: (entry: T) => number,
): Extract<Acceptance, { ok: false }> | undefined {
  if (entries.length !== expected) {
    return {
      ok: false,
      code: "unverifiable",
      detail: `verifier reply malformed: ${entries.length} ${name.prefix}verdicts for ${expected} ${name.plural}`,
    };
  }
  const disordered = entries.findIndex((e, i) => keyOf(e) !== i + 1);
  if (disordered !== -1) {
    return {
      ok: false,
      code: "unverifiable",
      detail: `verifier reply malformed: ${name.prefix}verdict ${disordered + 1} names ${name.singular} ${keyOf(entries[disordered] as T)}, expected ${disordered + 1}`,
    };
  }
  return undefined;
}

/** Every entry at or past this point matched, so the gate can accept. */
function flagged<T>(
  entries: readonly T[],
  name: Naming,
  keyOf: (entry: T) => number,
  isMismatch: (entry: T) => boolean,
  evidence: string,
): Acceptance | undefined {
  const bad = entries.filter(isMismatch).map(keyOf);
  if (bad.length === 0) return undefined;
  return {
    ok: false,
    code: "verifier-mismatch",
    detail: `mismatch on ${name.plural} ${bad.join(", ")} — see ${evidence}`,
  };
}

/**
 * One rule for both verifier blocks: a row named `could-not-run` carries a `mismatch` verdict. The
 * verifier prompt makes an undecidable row a mismatch, so any other verdict is the reply
 * contradicting itself — malformed, not a harness fault (#354). The callers differ only in how
 * they number rows and which evidence file they point at (#388).
 */
function contradictedRows(
  couldNotRun: number[],
  verdicts: readonly { row: number; verdict: string }[],
): number[] {
  return couldNotRun.filter((n) => verdicts.find((v) => v.row === n)?.verdict !== "mismatch");
}

function contradictionDetail(block: string, rows: number[], evidence: string): string {
  return `${block} reply contradicts itself: rows ${rows.join(", ")} carry a verdict and are named could-not-run — see ${evidence}`;
}

/**
 * The prompt runs a clone-root command as `cd <root> && <command>`, so undo exactly that and
 * collapse whitespace before comparing; everything else is the row's own text (#462).
 */
function asWritten(command: string): string {
  return command
    .replace(/^cd\s+.+?\s*&&\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A `match` says the row's command ran and its output supported the row. That is false when the
 * row's own command cannot run as written — a cell that kept its markdown delimiters (#463), an
 * unset variable (#401) — because the run it claims cannot have happened.
 */
function matchOnBrokenCommand(
  claims: readonly ClaimRow[],
  verdicts: readonly RowVerdict[],
  evidence: string,
): Extract<Acceptance, { ok: false }> | undefined {
  for (const v of verdicts) {
    if (v.verdict !== "match") continue;
    const claim = claims[v.row - 1];
    if (claim === undefined) continue; // `blockShape` proved the numbering
    const faults = commandFaults(claim.command);
    if (faults.length === 0) continue;
    return {
      ok: false,
      code: "harness-error",
      detail: `row ${v.row}: the command cannot run as written — ${faults.join(", ")} — see ${evidence}`,
    };
  }
  return undefined;
}

/**
 * A `match` also says the row's command ran and its output supported the row. That is false when the
 * verifier ran something else — the recorded mangling (#462) — or when its run failed with a tool
 * error. Exit 1 stays acceptable: grep's and rg's no-match is how an "absent" claim matches.
 */
function matchRanAsWritten(
  claims: readonly ClaimRow[],
  verdicts: readonly RowVerdict[],
  evidence: string,
): Extract<Acceptance, { ok: false }> | undefined {
  for (const v of verdicts) {
    if (v.verdict !== "match") continue;
    const claim = claims[v.row - 1];
    if (claim === undefined) continue; // `blockShape` proved the numbering
    // `acceptance` is exported and callers can build a block by hand, so fail closed rather than
    // crash on the missing field the parser would have refused.
    if (typeof v.command !== "string" || !Number.isInteger(v.exit)) {
      return {
        ok: false,
        code: "unverifiable",
        detail: `verifier reply malformed: row ${v.row} reports no command and exit — see ${VERDICT_EVIDENCE}`,
      };
    }
    if (asWritten(v.command) !== asWritten(claim.command)) {
      return {
        ok: false,
        code: "harness-error",
        detail: `row ${v.row}: the verifier ran a different command — ran \`${v.command}\`, the row says \`${claim.command}\` — see ${evidence}`,
      };
    }
    if (v.exit >= 2) {
      return {
        ok: false,
        code: "harness-error",
        detail: `row ${v.row}: the verifier's run exited ${v.exit} — see ${evidence}`,
      };
    }
  }
  return undefined;
}

/** The gate: one mismatch or one undecidable row rejects; a shape mismatch is unverifiable. */
/**
 * The shape half of the gate, on its own: the entries line up one-for-one with the report's rows
 * and criteria, and a row named could-not-run does not also carry a verdict. `prepare` uses it as
 * its retry predicate (#368), so a re-ask covers a block that parses but cannot be read, not only
 * one that fails to parse — a self-contradicting reply is that same class (#376).
 */
export function blockShape(
  block: VerifierBlock,
  rows: number,
  criteria: number,
): Extract<Acceptance, { ok: false }> | undefined {
  const row = (v: RowVerdict): number => v.row;
  const rowsLineUp = lineUp(block.verdicts, rows, ROWS, row);
  if (rowsLineUp !== undefined) return rowsLineUp;
  // One verdict per row is now proved, so a row named could-not-run also carries a verdict.
  const contradicted = contradictedRows(block.couldNotRun, block.verdicts);
  if (contradicted.length > 0) {
    return {
      ok: false,
      code: "unverifiable",
      detail: contradictionDetail("verifier", contradicted, VERDICT_EVIDENCE),
    };
  }
  if (criteria === 0) return undefined;
  if (block.dod === undefined) {
    return { ok: false, code: "unverifiable", detail: "verifier reply malformed: no DoD verdicts" };
  }
  const criterion = (v: DodVerdict): number => v.criterion;
  return lineUp(block.dod, criteria, CRITERIA, criterion);
}

export function acceptance(
  report: TriageReport,
  block: VerifierBlock,
  /** Where this block lives, so a refusal points at the file that holds the rows it lists. */
  evidence = VERDICT_EVIDENCE,
): Acceptance {
  // Unreachable from `prepare` — `parseClaims` refuses a table with no rows — but kept because
  // `acceptance` is exported: against zero claims every shape check passes vacuously and the gate
  // would accept a report that verified nothing (#392).
  if (report.claims.length === 0) {
    return { ok: false, code: "unverifiable", detail: "report has no claim rows" };
  }
  const row = (v: RowVerdict): number => v.row;
  // Shape first — row and DoD alignment, then self-contradiction: a reply that cannot be read
  // for one row cannot be read for anything else, and the repair round (#355) can never cure a
  // short DoD block, so paying for one there buys nothing (#376).
  const shape = blockShape(block, report.claims.length, report.criteria.length);
  if (shape !== undefined) return shape;
  if (block.couldNotRun.length > 0) {
    return {
      ok: false,
      code: "harness-error",
      detail: `could not run rows ${block.couldNotRun.join(", ")} — see ${evidence}`,
    };
  }
  // A `match` is a claim that the row's command ran as written; check that before believing it.
  const broken = matchOnBrokenCommand(report.claims, block.verdicts, evidence);
  if (broken !== undefined) return broken;
  const ranAsWritten = matchRanAsWritten(report.claims, block.verdicts, evidence);
  if (ranAsWritten !== undefined) return ranAsWritten;
  const rowsFlagged = flagged(block.verdicts, ROWS, row, (v) => v.verdict === "mismatch", evidence);
  if (rowsFlagged !== undefined) return rowsFlagged;

  // The DoD is the deliverable the run implements, so its soundness is gated too (#291): a
  // criterion the verifier flags as contradicting a verified claim or naming nothing real
  // is refused before any DoD comment is posted.
  if (report.criteria.length > 0 && block.dod !== undefined) {
    const criterion = (v: DodVerdict): number => v.criterion;
    const dodFlagged = flagged(
      block.dod,
      CRITERIA,
      criterion,
      (v) => v.verdict === "mismatch",
      evidence,
    );
    if (dodFlagged !== undefined) return dodFlagged;
  }
  // A criterion may name the claim rows it rests on, in the `rows 3, 7` form the prompt defines.
  // Every cited row must be one the verifier marked `match`, so the criterion's support is a row
  // that reproduced (#464). Run last: a mismatch has already been repaired or refused by here, so
  // this never takes a repairable run away from the repair round.
  if (report.criteriaFromBody !== true) {
    const missing = citationFault(report, block, evidence);
    if (missing !== undefined) return missing;
  }
  return { ok: true };
}

// shortcut: `rows 3-7` cites 3 and 7, not 4-6; widen this if reports start citing ranges.
const CITATION = /\brows?\s+(\d+(?:\s*(?:,|and)\s*\d+)*)/gi;

/** The row numbers a criterion cites, deduplicated and in the order written. */
export function citedRows(text: string): number[] {
  const rows: number[] = [];
  for (const m of text.matchAll(CITATION)) {
    for (const n of (m[1] ?? "").split(/[^0-9]+/)) {
      if (n !== "") rows.push(Number(n));
    }
  }
  return [...new Set(rows)];
}

/** The first citation that is not a row the verifier marked `match`, as a refusal (#464). */
function citationFault(
  report: TriageReport,
  block: VerifierBlock,
  evidence: string,
): Extract<Acceptance, { ok: false }> | undefined {
  for (const [i, criterion] of report.criteria.entries()) {
    for (const row of citedRows(criterion)) {
      if (block.verdicts.find((v) => v.row === row)?.verdict === "match") continue;
      return {
        ok: false,
        code: "unverifiable",
        detail: `criterion ${i + 1} cites row ${row}, which is not one the verifier marked match — see ${evidence}`,
      };
    }
  }
  return undefined;
}

/** One repaired row: the author corrected the `command` or `observed` cell of a flagged row. */
export interface RepairRow {
  row: number;
  command: string;
  observed: string;
}

function parseRepairEntry(entry: unknown, i: number, flagged: number[]): RepairRow {
  const msg = `repair entry ${i + 1} must be exactly {row, command, observed} naming a flagged row`;
  const e = entry as Record<string, unknown> | null;
  if (e === null || typeof e !== "object") throw new Error(msg);
  const keys = Object.keys(e);
  if (keys.length !== 3 || !keys.every((k) => k === "row" || k === "command" || k === "observed")) {
    throw new Error(msg);
  }
  const row = e.row;
  if (!Number.isInteger(row) || !flagged.includes(row as number)) throw new Error(msg);
  if (typeof e.command !== "string" || typeof e.observed !== "string") throw new Error(msg);
  return { row: row as number, command: e.command, observed: e.observed };
}

/**
 * Parse the author's repair reply: strictly one entry per flagged row, and each entry exactly
 * `{row, command, observed}`. An extra key (a criterion, a KIND, a DoD change) is a refusal,
 * not a silent ignore — the author may only touch the flagged rows' two cells.
 */
export function parseRepair(text: string, flagged: number[]): RepairRow[] {
  const fence = /```json\s*\n([\s\S]*?)```/.exec(text);
  if (fence === null) throw new Error("repair reply has no fenced ```json block");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1] ?? "");
  } catch (err) {
    throw new Error(`repair reply is not JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("repair reply is not a non-empty array of repaired rows");
  }
  const rows = parsed.map((entry, i) => parseRepairEntry(entry, i, flagged));
  const named = rows.map((r) => r.row).sort((a, b) => a - b);
  const expected = [...flagged].sort((a, b) => a - b);
  if (named.join() !== expected.join()) {
    throw new Error("repair reply must name each flagged row exactly once");
  }
  return rows;
}

/**
 * Fold a re-verification of the flagged rows alone back into the original block. The
 * re-verification's verdicts are numbered 1..flagged.length by `normalizeReverify`; map each back
 * to its original number and keep the original DoD verdicts, which it never re-checks.
 */
export function mergeReverify(
  block: VerifierBlock,
  flagged: number[],
  reverify: VerifierBlock,
): VerifierBlock {
  const verdicts = block.verdicts.map((v) => ({ ...v }));
  reverify.verdicts.forEach((rv, i) => {
    const original = flagged[i];
    if (original !== undefined) {
      verdicts[original - 1] = {
        row: original,
        verdict: rv.verdict,
        evidence: rv.evidence,
        command: rv.command,
        exit: rv.exit,
      };
    }
  });
  // A repaired row left in `couldNotRun` would make the merged block contradict itself: the gate
  // refuses a could-not-run row that carries a verdict, and the re-verify just gave it one (#401).
  const repaired = new Set(flagged);
  const couldNotRun = block.couldNotRun.filter((r) => !repaired.has(r));
  for (const r of reverify.couldNotRun) {
    const original = flagged[r - 1];
    if (original !== undefined) couldNotRun.push(original);
  }
  return { verdicts, couldNotRun, dod: block.dod };
}

/**
 * A re-verification names the flagged rows, and either numbering is accepted: the re-table's own
 * `1..n` (the verifier prompt's "table order") or the original claim-table numbers, which the
 * repair prompt writes out. When the flagged rows are `1..n` the two coincide, so a block is never
 * ambiguous (#372).
 *
 * Normalizing here is what makes position the single authority: `mergeReverify` consumes
 * `1..n` and never has to guess, and a `could-not-run` row is checked against the block it is in
 * rather than silently dropped when its number falls outside the re-table.
 */
export function normalizeReverify(
  block: VerifierBlock,
  flagged: number[],
): { ok: true; block: VerifierBlock; raw: VerifierBlock } | { ok: false; detail: string } {
  if (block.verdicts.length !== flagged.length) {
    return {
      ok: false,
      detail: `re-verification reply malformed: ${block.verdicts.length} verdicts for ${flagged.length} flagged row(s)`,
    };
  }
  const positionOf = new Map(flagged.map((row, i) => [row, i + 1]));
  const tableNumbered = block.verdicts.every((v, i) => v.row === i + 1);
  const originalNumbered =
    new Set(block.verdicts.map((v) => v.row)).size === flagged.length &&
    block.verdicts.every((v) => positionOf.has(v.row));
  if (!tableNumbered && !originalNumbered) {
    return {
      ok: false,
      detail: `re-verification reply malformed: rows ${block.verdicts.map((v) => v.row).join(", ")} name neither table positions 1-${flagged.length} nor flagged rows ${flagged.join(", ")}`,
    };
  }

  // One numbering for the whole function: the reply names either table positions or flagged rows.
  const toPosition = (n: number) => (tableNumbered ? n : (positionOf.get(n) as number));
  const isKnownRow = (n: number) =>
    tableNumbered ? n >= 1 && n <= flagged.length : positionOf.has(n);
  const verdicts = block.verdicts
    .map((v) => ({
      row: toPosition(v.row),
      verdict: v.verdict,
      evidence: v.evidence,
      command: v.command,
      exit: v.exit,
    }))
    // Sorted: `mergeReverify` consumes positions in order, so an out-of-order reply must not
    // shift one row's verdict onto another.
    .sort((a, b) => a.row - b.row);
  const stray = block.couldNotRun.filter((n) => !isKnownRow(n));
  if (stray.length > 0) {
    return {
      ok: false,
      detail: `re-verification reply malformed: could-not-run rows ${stray.join(", ")} are outside the rows re-verified (${flagged.join(", ")})`,
    };
  }
  const couldNotRun = block.couldNotRun.map(toPosition);
  // The rule `acceptance` applies to the claim block, on this block's numbering.
  const contradicted = contradictedRows(couldNotRun, verdicts);
  if (contradicted.length > 0) {
    return {
      ok: false,
      detail: contradictionDetail("re-verification", contradicted, REVERDICT_EVIDENCE),
    };
  }
  return { ok: true, block: { verdicts, couldNotRun, dod: block.dod }, raw: block };
}
