/**
 * One declaration of a RunScorecard's fields (#167). The ledger's allowlist is
 * derived from this table rather than re-typed by hand, so a field cannot exist
 * on the producer and quietly vanish on the way to the ledger.
 *
 * Absent means "not recorded", never zero: an optional field the writer did not
 * know about stays absent, so an older card is unmeasured instead of measuring as
 * "no re-work".
 */
import type { Mistake } from "./mistakes";
import type { RunScorecard } from "./scorecard";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const strOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" ? v : undefined;

const numOrNull = (v: unknown): number | null | undefined =>
  v === null ? null : isFiniteNum(v) ? v : undefined;

const numberMap = (v: unknown): Record<string, number> | undefined => {
  if (!isRecord(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!isFiniteNum(value)) return undefined;
    out[key] = value;
  }
  return out;
};

const numberArrayMap = (v: unknown): Record<string, number[]> | undefined => {
  if (!isRecord(v)) return undefined;
  const out: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!Array.isArray(value) || !value.every(isFiniteNum)) return undefined;
    out[key] = value;
  }
  return out;
};

const stringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

const cost = (v: unknown): RunScorecard["cost"] | undefined => {
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
};

const mistakes = (v: unknown): Mistake[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: Mistake[] = [];
  for (const m of v as unknown[]) {
    if (!isRecord(m)) return undefined;
    if (m.class !== "M1" && m.class !== "M2" && m.class !== "M3") return undefined;
    if (typeof m.detail !== "string") return undefined;
    out.push({ class: m.class, detail: m.detail });
  }
  return out;
};

export interface CardField {
  name: string;
  /** `undefined` means the value is unusable: refused if required, dropped if not. */
  parse: (raw: unknown) => unknown;
  /** A required field's absence or invalid value refuses the whole card. */
  optional?: boolean;
}

/**
 * The allowlist. Add a field here and it survives write → collect → aggregate;
 * the unit test drives this table, so a field with no parser cannot ship silently.
 */
export const CARD_FIELDS: readonly CardField[] = [
  { name: "taxonomyVersion", parse: (v) => (typeof v === "string" ? v : undefined) },
  {
    name: "task",
    parse: (v) => (typeof v === "string" && v !== "" ? v : undefined),
    optional: true,
  },
  {
    name: "attestationRounds",
    parse: (v) => (isFiniteNum(v) && v >= 0 ? v : undefined),
    optional: true,
  },
  {
    name: "firstAttestationRoundFailed",
    parse: (v) => (typeof v === "boolean" ? v : undefined),
    optional: true,
  },
  { name: "outcome", parse: strOrNull },
  { name: "exitCode", parse: numOrNull },
  { name: "outcomeExitMismatch", parse: (v) => (typeof v === "boolean" ? v : undefined) },
  {
    name: "dod",
    parse: (v) => (v === "met" || v === "unmet" || v === "unknown" ? v : undefined),
  },
  { name: "falseSuccess", parse: (v) => (typeof v === "boolean" ? v : undefined) },
  { name: "turnDurationsMs", parse: numberArrayMap },
  { name: "toolTimeMs", parse: (v) => (isFiniteNum(v) ? v : undefined) },
  { name: "toolTimeByAgentMs", parse: numberMap },
  { name: "toolCalls", parse: (v) => (isFiniteNum(v) ? v : undefined) },
  { name: "toolErrors", parse: (v) => (isFiniteNum(v) ? v : undefined) },
  { name: "retries", parse: (v) => (isFiniteNum(v) ? v : undefined) },
  { name: "correlationTimeouts", parse: (v) => (isFiniteNum(v) ? v : undefined) },
  { name: "agentCrashed", parse: (v) => (isFiniteNum(v) ? v : undefined) },
  { name: "agentUnusable", parse: (v) => (isFiniteNum(v) ? v : undefined) },
  { name: "agentStalled", parse: (v) => (isFiniteNum(v) ? v : undefined) },
  { name: "stopAgentReasons", parse: numberMap },
  { name: "cost", parse: cost },
  { name: "modelRoster", parse: stringArray },
  { name: "mistakes", parse: mistakes },
];

/** Rebuild a card from the declared fields only: the ledger's privacy allowlist. */
export function sanitizeCard(raw: unknown): RunScorecard | null {
  if (!isRecord(raw)) return null;
  const card: Record<string, unknown> = {};
  for (const field of CARD_FIELDS) {
    const value = field.parse(raw[field.name]);
    if (value === undefined) {
      if (field.optional === true) continue;
      return null;
    }
    card[field.name] = value;
  }
  return card as unknown as RunScorecard;
}
