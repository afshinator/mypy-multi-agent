/**
 * Improvement ledger (issue #16): tie a landed change to the mistake-class rate
 * it moved. A record names the target class plus the ledger prefix that existed
 * BEFORE the change landed, so "before" is ledger[0..beforeCount) and "after" is
 * the remainder. Measured over #19's append-only scorecard ledger, derived data
 * only.
 *
 * Mixed taxonomy versions are never compared (issue #13's "never silently
 * compare" rule): the measured version is resolved once and every other card is
 * filtered out, so the before/after sides always share one taxonomy.
 *
 * Records live in a hand-authored JSONL file (inputs, like quality/opt-in.json),
 * one object per line:
 *   {"change":"78930de","class":"M3","beforeCount":12}
 * `afterCount` caps the after side; `taxonomyVersion` pins the version to
 * measure (default: the newest card in the ledger).
 */
import { readFile, writeFile } from "node:fs/promises";
import type { RunScorecard } from "./scorecard";
import { readLedger } from "./trends";

export interface ImprovementRecord {
  /** Commit sha or issue ref the change landed as, e.g. "78930de" or "#22". */
  change: string;
  /** Target mistake class, e.g. "M3". */
  class: string;
  /** Ledger length at the moment the change landed; the "before" prefix. */
  beforeCount: number;
  /** Optional upper bound on the after side; omitted means the ledger end. */
  afterCount?: number;
  /** Taxonomy version to measure; omitted means the newest in the ledger. */
  taxonomyVersion?: string;
}

export interface ImprovementSide {
  scorecards: number;
  count: number;
  rate: number;
}

export type ImprovementVerdict = "improved" | "regressed" | "unchanged" | "not yet measurable";

export interface ImprovementReport {
  change: string;
  class: string;
  taxonomyVersion: string | null;
  before: ImprovementSide;
  after: ImprovementSide;
  /** after.rate - before.rate; null when either side is empty. */
  delta: number | null;
  verdict: ImprovementVerdict;
}

const clampIndex = (n: number, length: number): number =>
  Math.max(0, Math.min(Math.floor(n), length));

const measureSide = (cards: readonly RunScorecard[], cls: string): ImprovementSide => {
  const count = cards.filter((c) => c.mistakes.some((m) => m.class === cls)).length;
  return { scorecards: cards.length, count, rate: cards.length === 0 ? 0 : count / cards.length };
};

export function measureImprovement(
  record: ImprovementRecord,
  ledger: readonly RunScorecard[],
): ImprovementReport {
  const split = clampIndex(record.beforeCount, ledger.length);
  const end =
    record.afterCount === undefined ? ledger.length : clampIndex(record.afterCount, ledger.length);
  const beforeAll = ledger.slice(0, split);
  const afterAll = ledger.slice(split, Math.max(split, end));

  const version =
    record.taxonomyVersion ??
    afterAll[afterAll.length - 1]?.taxonomyVersion ??
    beforeAll[beforeAll.length - 1]?.taxonomyVersion ??
    null;

  const before = measureSide(
    beforeAll.filter((c) => c.taxonomyVersion === version),
    record.class,
  );
  const after = measureSide(
    afterAll.filter((c) => c.taxonomyVersion === version),
    record.class,
  );

  const measurable = version !== null && before.scorecards > 0 && after.scorecards > 0;
  const delta = measurable ? after.rate - before.rate : null;
  const verdict: ImprovementVerdict =
    delta === null
      ? "not yet measurable"
      : delta < 0
        ? "improved"
        : delta > 0
          ? "regressed"
          : "unchanged";

  return {
    change: record.change,
    class: record.class,
    taxonomyVersion: version,
    before,
    after,
    delta,
    verdict,
  };
}

export function measureAll(
  records: readonly ImprovementRecord[],
  ledger: readonly RunScorecard[],
): ImprovementReport[] {
  return records.map((record) => measureImprovement(record, ledger));
}

const renderSide = (side: ImprovementSide): string =>
  `${side.count}/${side.scorecards} (${side.rate.toFixed(3)})`;

const renderDelta = (delta: number | null): string =>
  delta === null ? "-" : `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`;

export function renderImprovements(reports: readonly ImprovementReport[]): string {
  const lines: string[] = ["# Improvement ledger", ""];
  if (reports.length === 0) {
    lines.push("No change records.", "");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "| change | class | taxonomy | before | after | delta | verdict |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of reports) {
    lines.push(
      `| ${r.change} | ${r.class} | ${r.taxonomyVersion ?? "-"} | ${renderSide(r.before)} | ${renderSide(r.after)} | ${renderDelta(r.delta)} | ${r.verdict} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const sanitizeRecord = (v: unknown): ImprovementRecord | null => {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.change !== "string" || r.change === "") return null;
  if (typeof r.class !== "string" || r.class === "") return null;
  if (typeof r.beforeCount !== "number" || !Number.isFinite(r.beforeCount)) return null;
  const out: ImprovementRecord = { change: r.change, class: r.class, beforeCount: r.beforeCount };
  if (typeof r.afterCount === "number" && Number.isFinite(r.afterCount))
    out.afterCount = r.afterCount;
  if (typeof r.taxonomyVersion === "string") out.taxonomyVersion = r.taxonomyVersion;
  return out;
};

export async function readImprovements(recordsPath: string): Promise<ImprovementRecord[]> {
  let text: string;
  try {
    text = await readFile(recordsPath, "utf8");
  } catch {
    return [];
  }
  const out: ImprovementRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = sanitizeRecord(parsed);
    if (record !== null) out.push(record);
  }
  return out;
}

export async function writeImprovements(
  recordsPath: string,
  ledgerPath: string,
  outPath: string,
): Promise<void> {
  const reports = measureAll(await readImprovements(recordsPath), await readLedger(ledgerPath));
  await writeFile(outPath, renderImprovements(reports));
}

if (import.meta.main) {
  const [
    recordsPath = "quality/improvements.jsonl",
    ledgerPath = "quality/ledger.jsonl",
    outPath = "quality/improvements.md",
  ] = process.argv.slice(2);
  await writeImprovements(recordsPath, ledgerPath, outPath);
}
