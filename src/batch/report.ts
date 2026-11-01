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
   * The `KIND:` answer: a policy kind, or `inline` for "do it without a run". Left
   * unvalidated here; `prepare` decides between a kind, `inline` and `kind-invalid`.
   */
  kind?: string;
}

export interface RowVerdict {
  row: number;
  verdict: "match" | "mismatch";
  evidence: string;
}

export interface VerifierBlock {
  verdicts: RowVerdict[];
  /** Row numbers named as `could-not-run`; an undecidable row is not a pass. */
  couldNotRun: number[];
}

export type Acceptance =
  | { ok: true }
  | { ok: false; code: "unverifiable" | "verifier-mismatch"; detail: string };

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

const FENCE = /```json\s*\n([\s\S]*?)```/;

export function parseVerifierBlock(text: string): VerifierBlock {
  const fenced = FENCE.exec(text);
  if (fenced === null) throw new Error("verifier reply has no fenced ```json block");

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1] ?? "");
  } catch (err) {
    throw new Error(`verifier block is not JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("verifier block is not an array of row verdicts");

  const verdicts = parsed.map((entry, i): RowVerdict => {
    const row = entry as Partial<RowVerdict> | null;
    const ok =
      row !== null &&
      typeof row === "object" &&
      Number.isInteger(row.row) &&
      (row.verdict === "match" || row.verdict === "mismatch") &&
      typeof row.evidence === "string";
    if (!ok) throw new Error(`verifier block entry ${i + 1} is not {row, verdict, evidence}`);
    return {
      row: row.row as number,
      verdict: row.verdict as "match" | "mismatch",
      evidence: row.evidence as string,
    };
  });

  const tail = /^could-not-run:\s*(.*)$/m.exec(text);
  if (tail === null) throw new Error("verifier reply has no could-not-run line");
  const named = (tail[1] ?? "").trim();
  const couldNotRun = /^none$/i.test(named)
    ? []
    : [...named.matchAll(/\d+/g)].map((m) => Number(m[0]));

  return { verdicts, couldNotRun };
}

/** The gate: one mismatch or one undecidable row rejects; a shape mismatch is unverifiable. */
export function acceptance(report: TriageReport, block: VerifierBlock): Acceptance {
  if (report.claims.length === 0) {
    return { ok: false, code: "unverifiable", detail: "report has no claim rows" };
  }
  if (block.verdicts.length !== report.claims.length) {
    return {
      ok: false,
      code: "unverifiable",
      detail: `${block.verdicts.length} verdicts for ${report.claims.length} rows`,
    };
  }
  const disordered = block.verdicts.findIndex((v, i) => v.row !== i + 1);
  if (disordered !== -1) {
    return {
      ok: false,
      code: "unverifiable",
      detail: `verdict ${disordered + 1} names row ${block.verdicts[disordered]?.row}, expected ${disordered + 1}`,
    };
  }
  if (block.couldNotRun.length > 0) {
    return {
      ok: false,
      code: "verifier-mismatch",
      detail: `could not run rows ${block.couldNotRun.join(", ")}`,
    };
  }
  const mismatched = block.verdicts.filter((v) => v.verdict === "mismatch").map((v) => v.row);
  if (mismatched.length > 0) {
    return {
      ok: false,
      code: "verifier-mismatch",
      detail: `mismatch on rows ${mismatched.join(", ")}`,
    };
  }
  return { ok: true };
}
