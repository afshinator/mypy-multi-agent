/**
 * Cross-project ledger collector (issue #19): reads only the project roots
 * listed in the committed opt-in file, rebuilds each scorecard through the
 * derived-metrics allowlist, and appends one JSON object per line to the ledger.
 * Append-only; never globs siblings, never scans parents, never truncates.
 *
 * Order is load-bearing: lines land in opt-in order, and a record's
 * `beforeCount` is a prefix of that order, so the opt-in list is kept in run-date
 * order to make "before the change" mean a window in time (ADR 0003).
 *
 * Privacy boundary (issue #13): the written line is rebuilt from an explicit
 * field allowlist, so prompt/code/transcript/system-prompt/decision/evidence/
 * report fields can never reach the ledger even if a scorecard.json grows them.
 */
import { appendFile, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Mistake } from "./mistakes";
import type { RunScorecard } from "./scorecard";

type UnknownRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is UnknownRecord => typeof v === "object" && v !== null;
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): number | null | undefined =>
  v === null ? null : isFiniteNum(v) ? v : undefined;
const strOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" ? v : undefined;

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v as unknown[];
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x !== "string") return undefined;
    out.push(x);
  }
  return out;
}

function numberMap(v: unknown): Record<string, number> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(v)) {
    if (!isFiniteNum(val)) return undefined;
    out[key] = val;
  }
  return out;
}

function numberArrayMap(v: unknown): Record<string, number[]> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, number[]> = {};
  for (const [key, val] of Object.entries(v)) {
    if (!Array.isArray(val)) return undefined;
    const nums: number[] = [];
    for (const x of val as unknown[]) {
      if (!isFiniteNum(x)) return undefined;
      nums.push(x);
    }
    out[key] = nums;
  }
  return out;
}

function sanitizeCost(v: unknown): RunScorecard["cost"] | undefined {
  if (!isRecord(v)) return undefined;
  const totalCostUsd = numOrNull(v.totalCostUsd);
  const totalTokens = numOrNull(v.totalTokens);
  const supervisorCostUsd = numOrNull(v.supervisorCostUsd);
  const supervisorTokens = numOrNull(v.supervisorTokens);
  if (
    totalCostUsd === undefined ||
    totalTokens === undefined ||
    supervisorCostUsd === undefined ||
    supervisorTokens === undefined
  ) {
    return undefined;
  }
  if (!Array.isArray(v.agents)) return undefined;
  const agents: RunScorecard["cost"]["agents"] = [];
  for (const a of v.agents as unknown[]) {
    if (!isRecord(a)) return undefined;
    if (typeof a.agentId !== "string" || !isFiniteNum(a.costUsd) || !isFiniteNum(a.tokens)) {
      return undefined;
    }
    agents.push({ agentId: a.agentId, costUsd: a.costUsd, tokens: a.tokens });
  }
  return { totalCostUsd, totalTokens, supervisorCostUsd, supervisorTokens, agents };
}

function sanitizeMistakes(v: unknown): Mistake[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Mistake[] = [];
  for (const m of v as unknown[]) {
    if (!isRecord(m)) return undefined;
    if (m.class !== "M1" && m.class !== "M2" && m.class !== "M3") return undefined;
    if (typeof m.detail !== "string") return undefined;
    out.push({ class: m.class, detail: m.detail });
  }
  return out;
}

/**
 * Rebuild a RunScorecard from only its derived-metrics fields. Unknown fields
 * are dropped, never passed through; this is the privacy allowlist for the
 * ledger line.
 */
export function sanitizeScorecard(v: unknown): RunScorecard | null {
  if (!isRecord(v)) return null;
  if (typeof v.taxonomyVersion !== "string") return null;
  const outcome = strOrNull(v.outcome);
  if (outcome === undefined) return null;
  const exitCode = numOrNull(v.exitCode);
  if (exitCode === undefined) return null;
  if (typeof v.outcomeExitMismatch !== "boolean") return null;
  if (v.dod !== "met" && v.dod !== "unmet" && v.dod !== "unknown") return null;
  if (typeof v.falseSuccess !== "boolean") return null;
  const turnDurationsMs = numberArrayMap(v.turnDurationsMs);
  if (turnDurationsMs === undefined) return null;
  if (!isFiniteNum(v.toolTimeMs)) return null;
  const toolTimeByAgentMs = numberMap(v.toolTimeByAgentMs);
  if (toolTimeByAgentMs === undefined) return null;
  if (!isFiniteNum(v.toolCalls) || !isFiniteNum(v.toolErrors) || !isFiniteNum(v.retries)) {
    return null;
  }
  if (
    !isFiniteNum(v.correlationTimeouts) ||
    !isFiniteNum(v.agentCrashed) ||
    !isFiniteNum(v.agentUnusable) ||
    !isFiniteNum(v.agentStalled)
  ) {
    return null;
  }
  const stopAgentReasons = numberMap(v.stopAgentReasons);
  if (stopAgentReasons === undefined) return null;
  const cost = sanitizeCost(v.cost);
  if (cost === undefined) return null;
  const modelRoster = stringArray(v.modelRoster);
  if (modelRoster === undefined) return null;
  const mistakes = sanitizeMistakes(v.mistakes);
  if (mistakes === undefined) return null;

  return {
    taxonomyVersion: v.taxonomyVersion,
    // Optional: a card written before these existed carries neither, and the
    // difference between absent and zero is the difference between "not
    // recorded" and "none happened", so absence is preserved.
    ...(typeof v.task === "string" && v.task !== "" ? { task: v.task } : {}),
    ...(isFiniteNum(v.attestationRounds) && v.attestationRounds >= 0
      ? { attestationRounds: v.attestationRounds }
      : {}),
    ...(typeof v.firstAttestationRoundFailed === "boolean"
      ? { firstAttestationRoundFailed: v.firstAttestationRoundFailed }
      : {}),
    outcome,
    exitCode,
    outcomeExitMismatch: v.outcomeExitMismatch,
    dod: v.dod,
    falseSuccess: v.falseSuccess,
    turnDurationsMs,
    toolTimeMs: v.toolTimeMs,
    toolTimeByAgentMs,
    toolCalls: v.toolCalls,
    toolErrors: v.toolErrors,
    retries: v.retries,
    correlationTimeouts: v.correlationTimeouts,
    agentCrashed: v.agentCrashed,
    agentUnusable: v.agentUnusable,
    agentStalled: v.agentStalled,
    stopAgentReasons,
    cost,
    modelRoster,
    mistakes,
  };
}

export type ScorecardRead = { ok: true; scorecard: RunScorecard } | { ok: false; reason: string };

export interface CollectionResult {
  root: string;
  ok: boolean;
  reason?: string;
}

export async function readOptIn(optInPath: string): Promise<string[]> {
  const raw = await readFile(optInPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${optInPath}: expected a JSON array of project root paths`);
  }
  const roots: string[] = [];
  for (const x of parsed as unknown[]) {
    if (typeof x !== "string") {
      throw new Error(`${optInPath}: expected only string project root paths`);
    }
    roots.push(x);
  }
  return roots;
}

function resolveRoot(entry: string): string {
  return isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
}

/** Read one opted-in root's run-details/scorecard.json through the allowlist. */
export async function readScorecard(root: string): Promise<ScorecardRead> {
  const scorecardPath = join(root, "run-details", "scorecard.json");
  let raw: string;
  try {
    raw = await readFile(scorecardPath, "utf8");
  } catch {
    return { ok: false, reason: "missing/unreadable run-details/scorecard.json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON in run-details/scorecard.json" };
  }
  const scorecard = sanitizeScorecard(parsed);
  if (scorecard === null) {
    return { ok: false, reason: "scorecard failed the derived-metrics allowlist" };
  }
  return { ok: true, scorecard };
}

export async function appendLedgerLine(ledgerPath: string, scorecard: RunScorecard): Promise<void> {
  await appendFile(ledgerPath, `${JSON.stringify(scorecard)}\n`);
}

/** Append one ledger line per opted-in root with a readable scorecard. */
export async function collect(optInPath: string, ledgerPath: string): Promise<CollectionResult[]> {
  const roots = await readOptIn(optInPath);
  const results: CollectionResult[] = [];
  for (const entry of roots) {
    const root = resolveRoot(entry);
    const read = await readScorecard(root);
    if (!read.ok) {
      results.push({ root, ok: false, reason: read.reason });
      continue;
    }
    // The opt-in entry names the run's task directory. Stamp it when the card
    // predates the field, so the corpus is attributable and filterable without
    // re-deriving artifacts a finished run owns. A card that carries its own
    // task keeps it: the run knows its directory better than the caller does.
    const card =
      read.scorecard.task === undefined ? { ...read.scorecard, task: entry } : read.scorecard;
    await appendLedgerLine(ledgerPath, card);
    results.push({ root, ok: true });
  }
  return results;
}

if (import.meta.main) {
  const [optInPath = "quality/opt-in.json", ledgerPath = "quality/ledger.jsonl"] =
    process.argv.slice(2);
  const results = await collect(optInPath, ledgerPath);
  for (const r of results) {
    if (!r.ok) console.error(`skip ${r.root}: ${r.reason}`);
  }
  console.log(`collected ${results.filter((r) => r.ok).length} scorecard(s) into ${ledgerPath}`);
}
