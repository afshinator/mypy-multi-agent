/**
 * Improvement ledger (issue #16): tie a landed change to the mistake-class rate
 * it moved. A record names the target class plus the ledger prefix that existed
 * BEFORE the change landed, so "before" is ledger[0..beforeCount) and "after" is
 * the remainder. Measured over #19's append-only scorecard ledger, derived data
 * only.
 *
 * A record may name a card **metric** instead of a class, and then the sides
 * compare that metric's mean. Use the metric when the improvement is continuous:
 * a binary class cannot show 11 rounds becoming 2, and reports it as a
 * regression because the flag stays true on both sides.
 *
 * Mixed taxonomy versions are never compared (issue #13's "never silently
 * compare" rule): the measured version is resolved once and every other card is
 * filtered out, so the before/after sides always share one taxonomy.
 *
 * Records live in a hand-authored JSONL file (inputs, like quality/opt-in.json),
 * one object per line:
 *   {"change":"78930de","class":"M3","beforeCount":12,"analysis":"mypi-tasks/post-mortem-e2e"}
 * `afterCount` caps the after side; `taxonomyVersion` pins the version to
 * measure (default: the newest card in the ledger). `analysis` names the
 * post-mortem whose findings motivated the change — the run's task directory,
 * because no artifact carries a run id (#90).
 */
import { writeFile } from "node:fs/promises";
import { readJsonl } from "../logging/conversation-log";
import type { RunScorecard } from "./scorecard";
import { readLedger } from "./trends";

export interface ImprovementRecord {
  /** Commit sha or issue ref the change landed as, e.g. "78930de" or "#22". */
  change: string;
  /**
   * The post-mortem this change came out of (#90), as its task directory — e.g.
   * "mypi-tasks/post-mortem-e2e". Nothing records a run id, so the directory is
   * the identity.
   */
  analysis?: string;
  /** Target mistake class, e.g. "M3". Exactly one of `class` and `metric`. */
  class?: string;
  /**
   * Target card metric, compared as a mean over the window instead of a rate.
   * See `ImprovementMetric` for when this is the right shape and `class` is not.
   *
   * A metric record can only become measurable once a card on *each* side carries
   * the value, so `beforeCount` must sit at or after the metric's first appearance
   * minus at least one measured card. A record whose before window predates the
   * metric is frozen at "not yet measurable" forever and measures nothing.
   */
  metric?: ImprovementMetric;
  /** Ledger length at the moment the change landed; the "before" prefix. */
  beforeCount: number;
  /** Optional upper bound on the after side; omitted means the ledger end. */
  afterCount?: number;
  /** Taxonomy version to measure; omitted means the newest in the ledger. */
  taxonomyVersion?: string;
}

/**
 * A card metric an improvement record can compare, as a mean over its window.
 *
 * Why a metric exists here at all: a class is binary, so it fires on both sides
 * of a continuous improvement and reports the improvement as a regression.
 * Attestation re-work is exactly that case — rounds went 11 → 4 → 2 while any
 * "did re-work happen" flag stayed true. Every metric is lower-is-better, like a
 * class rate: fewer rounds, less spend.
 */
export type ImprovementMetric = "attestationRounds";

/** How a card reports each metric; a card that does not carry one is not measured. */
const METRIC_OF: Record<ImprovementMetric, (card: RunScorecard) => number | undefined> = {
  attestationRounds: (card) => card.attestationRounds,
};

export interface ImprovementSide {
  /** Cards in the window that share the taxonomy version. */
  scorecards: number;
  /**
   * Cards that carry what is measured: for a class, cards with that mistake; for
   * a metric, cards that record a value. A card with no value is not a zero.
   */
  count: number;
  /** The class rate, or the metric's mean over `count` cards. */
  rate: number;
}

export type ImprovementVerdict = "improved" | "regressed" | "unchanged" | "not yet measurable";

export interface ImprovementReport {
  change: string;
  /** Carried through from the record so the rendered table can cite it (#90). */
  analysis?: string;
  /** Present on a class record. */
  class?: string;
  /** Present on a metric record. */
  metric?: ImprovementMetric;
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

/** Mean of a metric over the cards that carry it; a card without one is skipped,
 * never counted as zero. */
const measureMetric = (
  cards: readonly RunScorecard[],
  metric: ImprovementMetric,
): ImprovementSide => {
  const values = cards.map(METRIC_OF[metric]).filter((v): v is number => v !== undefined);
  const sum = values.reduce((s, v) => s + v, 0);
  return {
    scorecards: cards.length,
    count: values.length,
    rate: values.length === 0 ? 0 : sum / values.length,
  };
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

  const beforeCards = beforeAll.filter((c) => c.taxonomyVersion === version);
  const afterCards = afterAll.filter((c) => c.taxonomyVersion === version);
  const measure = (cards: readonly RunScorecard[]): ImprovementSide =>
    record.metric === undefined
      ? measureSide(cards, record.class ?? "")
      : measureMetric(cards, record.metric);
  const before = measure(beforeCards);
  const after = measure(afterCards);

  // A class is measurable when both windows hold cards. A metric is stricter: a
  // window with no card carrying the value is a gap, not a zero.
  const measurable =
    version !== null &&
    (record.metric === undefined
      ? before.scorecards > 0 && after.scorecards > 0
      : before.count > 0 && after.count > 0);
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
    ...(record.analysis === undefined ? {} : { analysis: record.analysis }),
    ...(record.class === undefined ? {} : { class: record.class }),
    ...(record.metric === undefined ? {} : { metric: record.metric }),
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

/** A mean is not a rate: `0/7 (0.000)` for a metric would read as "the mean is
 * zero" when it means "no card in that window recorded a value". */
const renderMetricSide = (side: ImprovementSide): string =>
  side.count === 0 ? "no card measured" : `mean ${side.rate.toFixed(3)} over ${side.count} card(s)`;

const renderDelta = (delta: number | null): string =>
  delta === null ? "-" : `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`;

export function renderImprovements(reports: readonly ImprovementReport[]): string {
  const lines: string[] = ["# Improvement ledger", ""];
  if (reports.length === 0) {
    lines.push("No change records.", "");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "| change | analysis | measure | taxonomy | before | after | delta | verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of reports) {
    const side = r.metric === undefined ? renderSide : renderMetricSide;
    lines.push(
      `| ${r.change} | ${r.analysis ?? "-"} | ${r.class ?? r.metric ?? "-"} | ${r.taxonomyVersion ?? "-"} | ${side(r.before)} | ${side(r.after)} | ${renderDelta(r.delta)} | ${r.verdict} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const sanitizeRecord = (v: unknown): ImprovementRecord | null => {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.change !== "string" || r.change === "") return null;
  const hasClass = typeof r.class === "string" && r.class !== "";
  const hasMetric = typeof r.metric === "string" && r.metric in METRIC_OF;
  // Exactly one: a record measures a class rate or a metric mean, never both.
  if (hasClass === hasMetric) return null;
  if (typeof r.beforeCount !== "number" || !Number.isFinite(r.beforeCount)) return null;
  const out: ImprovementRecord = { change: r.change, beforeCount: r.beforeCount };
  if (hasClass) out.class = r.class as string;
  if (hasMetric) out.metric = r.metric as ImprovementMetric;
  if (typeof r.afterCount === "number" && Number.isFinite(r.afterCount))
    out.afterCount = r.afterCount;
  if (typeof r.taxonomyVersion === "string") out.taxonomyVersion = r.taxonomyVersion;
  // Backwards compatible: a record authored before #90 has no analysis and
  // still parses; an empty string is treated as absent.
  if (typeof r.analysis === "string" && r.analysis !== "") out.analysis = r.analysis;
  return out;
};

export async function readImprovements(recordsPath: string): Promise<ImprovementRecord[]> {
  const out: ImprovementRecord[] = [];
  for (const entry of await readJsonl(recordsPath)) {
    const record = sanitizeRecord(entry);
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
