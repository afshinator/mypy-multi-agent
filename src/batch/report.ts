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
  /** As written: `true` | `partial` | `false`, or anything else the author used. */
  verdict: string;
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
   * The `KIND:` answer: a policy kind. Left unvalidated here; `prepare` accepts only
   * policy kinds and refuses anything else as `kind-invalid`.
   */
  kind?: string;
}

export interface RowVerdict {
  row: number;
  verdict: "match" | "mismatch";
  evidence: string;
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

/** A cell is usually one code span; keep the text, drop the delimiters. */
function unwrap(cell: string): string {
  const m = /^`([^`]*)`$/.exec(cell);
  return m?.[1] ?? cell;
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
    claim: unwrap(cells[0] ?? ""),
    command: unwrap(cells[1] ?? ""),
    observed: unwrap(cells[2] ?? ""),
    verdict: unwrap(cells[3] ?? "").toLowerCase(),
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
    const item = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
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

type Entry = { verdict: "match" | "mismatch"; evidence: string };

/**
 * One parser for both verifier blocks: they differ only in the key that numbers the entry
 * (`row` for the claim table, `criterion` for the DoD). Fails closed on any other shape.
 */
function parseVerdicts<K extends string>(
  jsonText: string,
  key: K,
  label: string,
): (Entry & Record<K, number>)[] {
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
    return {
      [key]: e[key] as number,
      verdict: e.verdict as "match" | "mismatch",
      evidence: e.evidence as string,
    } as Entry & Record<K, number>;
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
): Acceptance | undefined {
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
): Acceptance | undefined {
  const bad = entries.filter(isMismatch).map(keyOf);
  if (bad.length === 0) return undefined;
  return {
    ok: false,
    code: "verifier-mismatch",
    detail: `mismatch on ${name.plural} ${bad.join(", ")} — see ${VERDICT_EVIDENCE}`,
  };
}

/** The gate: one mismatch or one undecidable row rejects; a shape mismatch is unverifiable. */
export function acceptance(report: TriageReport, block: VerifierBlock): Acceptance {
  if (report.claims.length === 0) {
    return { ok: false, code: "unverifiable", detail: "report has no claim rows" };
  }
  const row = (v: RowVerdict): number => v.row;
  const rowsLineUp = lineUp(block.verdicts, report.claims.length, ROWS, row);
  if (rowsLineUp !== undefined) return rowsLineUp;
  if (block.couldNotRun.length > 0) {
    return {
      ok: false,
      code: "harness-error",
      detail: `could not run rows ${block.couldNotRun.join(", ")} — see ${VERDICT_EVIDENCE}`,
    };
  }
  const rowsFlagged = flagged(block.verdicts, ROWS, row, (v) => v.verdict === "mismatch");
  if (rowsFlagged !== undefined) return rowsFlagged;

  // The DoD is the deliverable the run implements, so its soundness is gated too (#291): a
  // criterion the verifier flags as contradicting a verified claim or naming nothing real
  // is refused before any DoD comment is posted.
  if (report.criteria.length > 0) {
    if (block.dod === undefined) {
      return {
        ok: false,
        code: "unverifiable",
        detail: "verifier reply malformed: no DoD verdicts",
      };
    }
    const criterion = (v: DodVerdict): number => v.criterion;
    const dodLineUp = lineUp(block.dod, report.criteria.length, CRITERIA, criterion);
    if (dodLineUp !== undefined) return dodLineUp;
    const dodFlagged = flagged(block.dod, CRITERIA, criterion, (v) => v.verdict === "mismatch");
    if (dodFlagged !== undefined) return dodFlagged;
  }
  return { ok: true };
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
 * re-verification numbers its rows 1..flagged.length; map each back to its original number and
 * keep the original DoD verdicts, which the re-verification never re-checks.
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
      verdicts[original - 1] = { row: original, verdict: rv.verdict, evidence: rv.evidence };
    }
  });
  const couldNotRun = [...block.couldNotRun];
  for (const r of reverify.couldNotRun) {
    const original = flagged[r - 1];
    if (original !== undefined) couldNotRun.push(original);
  }
  return { verdicts, couldNotRun, dod: block.dod };
}
