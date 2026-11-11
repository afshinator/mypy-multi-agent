/**
 * The order here is the safety property. Every validation that can refuse a ticket runs
 * before the first fact is published: the manifest is built and its models are resolved
 * before the comment exists, and the comment's criteria are proven equal to the manifest's
 * before `ready-for-agent` goes on. Reverse two steps and a ticket can be labelled ready
 * with a manifest that will not launch — and every unit test in the repo still passes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYamlText } from "yaml";
import { type AgentRun, extractPromptBlock } from "./agent";
import { normalizeDoD } from "./dod";
import { acquirePrepareLock, prepareLockPath } from "./lock";
import { buildManifestText } from "./manifest";
import { DEFAULT_BATCH_DIR, DEFAULT_TASK_DIR } from "./paths";
import type { BatchPolicy } from "./policy";
import {
  acceptance,
  blockShape,
  claimRowsText,
  commandFaults,
  commandSafetyFaults,
  definitionOfDone,
  dialectFaults,
  MERGED_EVIDENCE,
  mergeReverify,
  normalizeReverify,
  parseRepair,
  parseTriageReport,
  parseVerifierBlock,
  REVERDICT_EVIDENCE,
  type TriageReport,
  VERDICT_EVIDENCE,
  type VerifierBlock,
} from "./report";
import type { BatchRequest } from "./request";
import { batchTaskSlug } from "./request";
import type { TicketSnapshot, Tracker } from "./tracker";

/**
 * Every file a prepare writes and where, relative to the ticket directory. Each attempt owns the
 * raw evidence (#460); only the manifest and the deciding record sit at the ticket root, because
 * `run` and `status` read them there (#424).
 */
export const PREPARE_RECORD_FILES = [
  { file: "report.md", dir: "attempts/<k>/" },
  { file: VERDICT_EVIDENCE, dir: "attempts/<k>/" },
  { file: "repair.md", dir: "attempts/<k>/" },
  { file: REVERDICT_EVIDENCE, dir: "attempts/<k>/" },
  { file: MERGED_EVIDENCE, dir: "attempts/<k>/" },
  { file: "retries.json", dir: "attempts/<k>/" },
  { file: "identity.json", dir: "attempts/<k>/" },
  { file: "decision.json", dir: "attempts/<k>/" },
  { file: "manifest.yaml", dir: "" },
  { file: "acceptance.json", dir: "" },
  { file: "refusal.json", dir: "" },
] as const;

/** The four paid agent calls a prepare makes, named so a retried one is visible in the record. */
export type RetriedSite = "triage" | "verifier" | "repair" | "re-verify";

/** The retry trail as one label, empty when nothing was retried; each caller adds its separator (#389). */
export function retriedLabel(sites: readonly RetriedSite[]): string {
  return sites.length === 0 ? "" : `retried: ${sites.join(", ")}`;
}

/** The wall time each site's deciding call took; a site that was never called is absent, not zero. */
type SiteWallTimes = Partial<Record<RetriedSite, number>>;

/**
 * What one paid attempt cost in work, not only in time (#512). One entry per attempt, so a retried
 * site keeps both; a site that made no call has no entry at all, and a provider that reported no
 * tokens leaves those fields out rather than claiming a zero.
 */
export interface CallTelemetry {
  site: RetriedSite;
  attempt: number;
  durationMs: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** The record's telemetry: absent when no call was paid for, never an empty list (#512). */
function callsField(calls: CallTelemetry[] | undefined): { calls?: CallTelemetry[] } {
  return calls === undefined || calls.length === 0 ? {} : { calls };
}

/**
 * What share of the one knob each site may spend (#403). Triage and the verifier are the first
 * look at the ticket and get it whole. The repair round only corrects two cells of flagged rows
 * and the re-verification only re-runs those rows, so a hung repair must not cost a triage.
 */
const SITE_SHARE: Record<RetriedSite, number> = {
  triage: 1,
  verifier: 1,
  repair: 1 / 3,
  "re-verify": 1 / 3,
};

/**
 * One ticket's whole prepare may spend twice the knob. The site permits sum above this on
 * purpose: the deadline is the real bound, and the permits only decide which site gets cut.
 * Worst case is stated beside the two existing bounds in docs/batch-guide.md (#403).
 */
const DEADLINE_SHARE = 2;

export const PREPARE_REASON_CODES = [
  "not-needed",
  "skipped",
  "unverifiable",
  "infra-error",
  "harness-error",
  "verifier-mismatch",
  "dod-rejected",
  "dod-unapplied",
  "kind-invalid",
  "template-missing",
  "already-prepared",
  "manifest-invalid",
  "model-unavailable",
] as const;
export type ReasonCode = (typeof PREPARE_REASON_CODES)[number];

/**
 * The refusals that say something about the ticket's own text, so a human has to edit the ticket
 * before another prepare can pay off. The rest are not this class: `infra-error` and `harness-error`
 * are re-run, `kind-invalid`, `template-missing`, `manifest-invalid` and `model-unavailable` are
 * policy, `already-prepared` is a record, and `not-needed`/`skipped` are a closed or opted-out
 * ticket. Only these four are allowed to move a label (#502).
 */
export const TICKET_FAULT_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "unverifiable",
  "verifier-mismatch",
  "dod-rejected",
  "dod-unapplied",
]);

/**
 * What a human has to change so that another prepare can pay off. The code names the fault; without
 * this, a refusal is a dead end — the comment says the ticket failed and nothing says why it is worth
 * editing or where (#502).
 */
export const REFUSAL_REMEDY: Record<ReasonCode, string> = {
  "not-needed":
    "the issue is not open. Reopen it if the work is still wanted; there is nothing to edit.",
  skipped: "a human opted this ticket out. Remove the skip label to let a prepare consider it.",
  unverifiable:
    "a reply or a claim command could not be used. Read the attempt's report.md, fix what it names in the ticket, then prepare again.",
  "infra-error":
    "ours, not the ticket's: an agent call or a prompt document failed. Re-run the prepare.",
  "harness-error":
    "ours: a claim command could not run in the clone. Re-run the prepare; if it repeats, the command needs a form the environment can run.",
  "verifier-mismatch":
    "a claim in the ticket is false, or a criterion names nothing testable. Correct the ticket's stated facts or its Definition of Done, then prepare again.",
  "dod-rejected":
    "a criterion in the body will not fold to plain text, or names nothing testable. Edit the body's criteria, then prepare again.",
  "dod-unapplied":
    "the agent brief proposes a criterion the body does not carry. Apply it to the body first, then prepare again.",
  "kind-invalid":
    "the pinned kind is not one the policy offers. Fix the flag or the policy's kinds; the ticket needs no change.",
  "template-missing":
    "a kind has no template. Add it to the policy's kind_templates; the ticket needs no change.",
  "already-prepared":
    "a record for this ticket already exists in this batch. Run it, or use a new batch id.",
  "manifest-invalid":
    "the manifest could not be built from the kind's template. Fix the template; the ticket needs no change.",
  "model-unavailable":
    "a model slug does not resolve. Fix the slug in the policy or the template; the ticket needs no change.",
};

export interface TicketOutcome {
  ticket: number;
  ok: boolean;
  code?: ReasonCode;
  detail?: string;
  kind?: string;
  criteria?: string[];
  slug?: string;
  costUsd?: number;
  /** Call sites that were asked a second time; empty when nothing failed (#368). */
  retried?: RetriedSite[];
  /** Wall time each site's deciding call took, so the bound can be tuned from the record (#403). */
  durations?: SiteWallTimes;
  /** Work each paid attempt cost, per site and attempt, so a turn is not inferred from time (#512). */
  calls?: CallTelemetry[];
  /**
   * Where this attempt's triage reply came from: a call it paid for, or an earlier attempt's
   * recorded reply it read (#466, #484). Absent only when no triage reply was ever obtained.
   */
  triage?: { ran: true } | { reusedFrom: number };
}

type Verified =
  | {
      ok: false;
      code: ReasonCode;
      detail: string;
      costUsd?: number;
      retried?: RetriedSite[];
      durations?: SiteWallTimes;
      calls?: CallTelemetry[];
      triage?: { ran: true } | { reusedFrom: number };
    }
  | {
      ok: true;
      kind: string;
      criteria: string[];
      slug: string;
      manifestText: string;
      costUsd: number;
      retried: RetriedSite[];
      triage?: { ran: true } | { reusedFrom: number };
      durations: SiteWallTimes;
      calls: CallTelemetry[];
    };

export interface PrepareDeps {
  /** Where the task dirs and the batch record live. */
  cwd: string;
  /** The configured task dir for the human-launchable manifest copy; defaults to `mypi-tasks`. */
  taskDir?: string;
  /** The record segment under `taskDir`; defaults to `000-batches`. */
  batchDir?: string;
  tracker: Tracker;
  agent: (input: {
    prompt: string;
    model: string;
    cwd: string;
    timeoutMs: number;
  }) => Promise<AgentRun>;
  preflight: (slugs: string[]) => Promise<{ slug: string; ok: boolean }[]>;
  clone: { make(): Promise<string>; remove(dir: string): Promise<void> };
  /** The revision a clone was made from, recorded in the attempt identity (#460). */
  revision: (dir: string) => string;
}

// The prompts are driver assets, not target-repo files: a batch must work against any
// repo, so they resolve against this module's own location, not `repoRoot` (#278).
const PROMPT_DOCS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/explorations/triage-automation",
);
// Same for the kind templates: the default template ships with the driver, so the
// config's relative path (e.g. "templates/batch-code-fix.yaml") resolves against the
// driver repo root, not the target repo (#287). An absolute path still works.
const DRIVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** `<cwd>/<taskDir>/<batchDir>` — where a batch's record lives. */
function recordRoot(deps: PrepareDeps): string {
  return join(deps.cwd, deps.taskDir ?? DEFAULT_TASK_DIR, deps.batchDir ?? DEFAULT_BATCH_DIR);
}

export function markerFor(batch: string, ticket: number): string {
  return `<!-- mypi-batch:${batch}:${ticket} -->`;
}

export type CommentInput =
  | {
      accepted: true;
      kind: string;
      slug?: string;
      criteria: string[];
      /** Sites asked twice; named so the ticket shows a retry happened (#375). */
      retried?: RetriedSite[];
    }
  | { accepted: false; code: string; detail?: string; retried?: RetriedSite[] };

/** The writeback body: one `- ` line per criterion, so a dropped criterion is visible. */
export function commentText(input: CommentInput): string {
  const label = retriedLabel(input.retried ?? []);
  const note = label === "" ? "" : `\n\n${label}`;
  if (!input.accepted) {
    const remedy = REFUSAL_REMEDY[input.code as ReasonCode];
    const why = (input.detail ?? "").trim();
    const fix = remedy === undefined ? "" : `\n\nWhat to change: ${remedy}`;
    return `prepare refused this ticket: **${input.code}**${why === "" ? "" : `\n\n${why}`}${fix}${note}`;
  }
  const lines = [`kind: ${input.kind}`];
  if (input.slug !== undefined) lines.push(`run: ${input.slug}`);
  lines.push("", "Definition of Done:", ...input.criteria.map((c) => `- ${c}`));
  return lines.join("\n") + note;
}

/** The comment is what a human approves, so it may not add or lose a criterion. */
export function assertCommentCriteria(text: string, criteria: string[]): void {
  const listed = text
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  if (listed.length !== criteria.length || listed.some((c, i) => c !== criteria[i])) {
    throw new Error("comment criteria do not match the manifest's");
  }
}

/** Slugs the manifest resolves at launch: the supervisor's and every agent's. */
export function manifestSlugs(manifestText: string): string[] {
  const parsed = parseYaml(manifestText);
  const slugs = [
    parsed.session?.supervisor_model,
    ...(parsed.agents ?? []).map((agent) => agent.model),
  ];
  return slugs.filter((slug): slug is string => typeof slug === "string");
}

function parseYaml(text: string): {
  session?: { supervisor_model?: string };
  agents?: { model?: string }[];
} {
  return parseYamlText(text) as {
    session?: { supervisor_model?: string };
    agents?: { model?: string }[];
  };
}

/** The criteria `prepare` publishes: normalized, non-empty, and safe for the gate. */
function acceptCriteria(report: {
  criteria: string[];
}): { ok: true; criteria: string[] } | { ok: false; code: ReasonCode; detail: string } {
  const normalized = normalizeDoD(report.criteria);
  if (normalized.criteria.length === 0)
    return { ok: false, code: "dod-rejected", detail: "no criteria" };
  if (normalized.problems.length > 0) {
    return {
      ok: false,
      code: "dod-rejected",
      detail: normalized.problems.map((p) => `criterion ${p.index + 1}: ${p.reason}`).join("; "),
    };
  }
  return { ok: true, criteria: normalized.criteria };
}

const NOTES_MARKER = "## The kind notes";
/** The prompt document's `- <kind>: <what it does>` line; the guard reads it too (#389). */
export const KIND_LINE = /^- ([a-z][a-z0-9-]*): (.+)$/;

/**
 * The prompt document's kind notes — one `- <kind>: <what it does>` per shipped kind, plus the
 * prose that explains when a `-solo` kind will not do. They live in the prompt, not here, because
 * every other word the agent reads does (#377); `kindNoteLines` is the reading half.
 */
export function kindNoteLines(docText: string): string[] {
  const at = docText.indexOf(NOTES_MARKER);
  if (at === -1) throw new Error(`triage prompt has no "${NOTES_MARKER}" section`);
  const rest = docText.slice(at);
  const open = rest.indexOf("```text");
  const close = open === -1 ? -1 : rest.indexOf("```", open + 7);
  if (open === -1 || close === -1) throw new Error("the kind notes are not in a ```text block");
  return rest
    .slice(open + 7, close)
    .trim()
    .split("\n");
}

/**
 * A policy kind the prompt document cannot describe is a harness fault, not a judgement on the
 * ticket, and nothing about it depends on the ticket — so the message is built here once and
 * refused before the checkout is copied (#386).
 */
function undescribedKindFault(doc: string, kinds: string[]): string | undefined {
  const described = new Set(
    kindNoteLines(doc)
      .map((line) => KIND_LINE.exec(line)?.[1])
      .filter((kind) => kind !== undefined),
  );
  const undescribed = kinds.filter((kind) => !described.has(kind));
  if (undescribed.length === 0) return undefined;
  return `triage prompt describes no kind ${undescribed.join(", ")} — add a line to "${NOTES_MARKER}"`;
}

function triagePrompt(
  ticket: number,
  kinds: string[],
  pinnedKind?: string,
  bodyDoD?: string[],
): string {
  const doc = readFileSync(join(PROMPT_DOCS, "triage-prompt.md"), "utf8");
  const body = extractPromptBlock(doc).replaceAll("#NNN", `#${ticket}`);
  const fault = undescribedKindFault(doc, pinnedKind === undefined ? kinds : [pinnedKind]);
  if (fault !== undefined) throw new Error(fault);
  const lines = kindNoteLines(doc);
  const kept = lines.filter((line) => {
    const kind = KIND_LINE.exec(line)?.[1];
    return kind === undefined || kinds.includes(kind);
  });
  // The body owns the DoD (#469): the agent verifies the given criteria instead of authoring them,
  // and returns them unchanged so the reply still parses against the documented format.
  const given =
    bodyDoD === undefined
      ? []
      : [
          "",
          "THE DoD IS GIVEN",
          "The ticket already states its Definition of Done. Do not author criteria or proofs:",
          "verify each criterion below is checkable by a later session and fails on today's tree,",
          "and return it unchanged in the Definition of Done section so the reply parses.",
          ...bodyDoD.map((criterion) => `- ${criterion}`),
        ];
  if (pinnedKind !== undefined) {
    // Decided by the caller: asking for a classification invites a different answer.
    return [
      body,
      "",
      "KIND",
      `The kind is already decided: ${pinnedKind}. Do not write a KIND line.`,
      "",
      ...kept,
      ...given,
      "",
    ].join("\n");
  }
  return [
    body,
    "",
    "KIND",
    `End your reply with one line, exactly: \`KIND: <one of ${kinds.join(", ")}>\`.`,
    "",
    ...kept,
    ...given,
    "",
  ].join("\n");
}

function verifierPrompt(clone: string, claimsText: string, dodText: string): string {
  const doc = readFileSync(join(PROMPT_DOCS, "triage-verifier.md"), "utf8");
  return extractPromptBlock(doc)
    .replaceAll("<CLONE ROOT>", clone)
    .replace("<paste the report's claim rows here>", claimsText)
    .replace("<paste the report's Definition of Done here, one criterion per line>", dodText);
}

function repairPrompt(flaggedText: string): string {
  const doc = readFileSync(join(PROMPT_DOCS, "triage-repair.md"), "utf8");
  return extractPromptBlock(doc).replace("<FLAGGED ROWS>", flaggedText);
}

type AgentCall = (
  input: {
    prompt: string;
    model: string;
  },
  /** Which site is spending, so the permit is chosen per site rather than once per ticket. */
  site: RetriedSite,
) => Promise<
  // `durationMs` is absent only when no call was made at all: a site refused because the prepare
  // has no budget left has no wall time, and absent is not zero (#384, #403).
  { run: AgentRun; durationMs: number } | { error: string; durationMs?: number }
>;

type Failure = { code: ReasonCode; detail: string };

/**
 * What the second attempt is told about the first. A parser's rejection names the fault in the
 * terms the prompt already uses (`5 verdicts for 6 rows`), so the re-ask repairs it instead of
 * resampling the same mistake (#374).
 */
function retryNote(prior: Failure | undefined): string {
  if (prior === undefined) return "";
  return [
    "",
    "RETRY",
    `Your previous reply could not be read: ${prior.detail}`,
    "Answer the same request again, correcting exactly that and changing nothing else.",
    "",
  ].join("\n");
}

type Attempt<T> =
  | { ok: true; value: T; text: string; costUsd: number }
  | { ok: false; code: ReasonCode; detail: string; text: string; costUsd: number };

/**
 * One retry per call site (#368). A throw is infra noise at all four sites — the batch guide
 * already calls it retryable infrastructure. A reply that does not parse is re-asked at the
 * three sites where a format slip is the only fault, and never at triage: a second triage
 * sample would re-decide the ticket instead of re-checking a format.
 */
async function attemptTwice<T>(args: {
  callAgent: AgentCall;
  site: RetriedSite;
  /** Built per attempt, so the second can name what the first got wrong (#374). */
  input: (prior?: Failure) => { prompt: string; model: string };
  parse: (text: string) => T;
  retryParse: boolean;
  evidence: Evidence;
}): Promise<Attempt<T>> {
  let costUsd = 0;
  let text = "";
  // The first failure decides the code (#373): a throw is `infra-error` and a bad reply is
  // `unverifiable`, so the same pair of failures must not report either one by attempt order.
  let failure: Failure | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Only a reply that was read and rejected is worth describing. A throw produced no reply, so
    // re-sending the identical prompt is the whole of what a retry can do there.
    const prior = failure?.code === "unverifiable" ? failure : undefined;
    const call = await args.callAgent(args.input(prior), args.site);
    const durationMs = call.durationMs;
    // The attempt that decided the site; a replaced attempt keeps its own on `rejected` (#403).
    if (durationMs !== undefined) args.evidence.durations[args.site] = durationMs;
    // One entry per attempt: a site that made no call has no duration, so it has no entry either,
    // and a throw answered nothing, so its turns and tokens stay absent (#512).
    if (durationMs !== undefined) {
      args.evidence.calls.push(
        "error" in call
          ? { site: args.site, attempt: attempt + 1, durationMs }
          : {
              site: args.site,
              attempt: attempt + 1,
              durationMs,
              costUsd: call.run.costUsd,
              ...(call.run.turns === undefined ? {} : { turns: call.run.turns }),
              ...(call.run.inputTokens === undefined ? {} : { inputTokens: call.run.inputTokens }),
              ...(call.run.outputTokens === undefined
                ? {}
                : { outputTokens: call.run.outputTokens }),
            },
      );
    }
    if ("error" in call) {
      failure ??= { code: "infra-error", detail: call.error };
      // No call was made, so there is nothing to re-send: the same guard refuses it again.
      if (durationMs === undefined) return { ok: false, ...(failure as Failure), text, costUsd };
    } else {
      costUsd += call.run.costUsd;
      text = call.run.text;
      try {
        return { ok: true, value: args.parse(call.run.text), text, costUsd };
      } catch (err) {
        failure ??= { code: "unverifiable", detail: (err as Error).message };
        if (!args.retryParse) return { ok: false, ...(failure as Failure), text, costUsd };
      }
    }
    if (attempt === 0) {
      args.evidence.retried.push(args.site);
      // What the replaced attempt said, so a reader can see what was rejected and what replaced
      // it. A throw answered nothing, so its text is empty and the fault is the detail (#375).
      args.evidence.rejected.push({
        site: args.site,
        text,
        detail: (failure as Failure).detail,
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    }
  }
  return { ok: false, ...(failure as Failure), text, costUsd };
}

/**
 * One bounded repair round (D1-D3): the author corrects only the flagged rows' `command` and
 * `observed` cells, then the verifier re-runs those rows alone. Mutates the report's claims in
 * place and returns the merged block; a failure returns a terminal refusal code.
 */
async function repairRound(
  callAgent: AgentCall,
  policy: BatchPolicy,
  clone: string,
  report: TriageReport,
  block: VerifierBlock,
  flaggedRows: number[],
  evidence: Evidence,
): Promise<
  { repaired: true; block: VerifierBlock } | { repaired: false; code: ReasonCode; detail: string }
> {
  const fail = (code: ReasonCode, detail: string) => ({ repaired: false as const, code, detail });

  const flaggedText = flaggedRows
    .map((r) => {
      const claim = report.claims[r - 1];
      if (claim === undefined) return `row ${r}: (missing claim)`;
      const v = block.verdicts.find((x) => x.row === r);
      return `row ${r}: command \`${claim.command}\` observed \`${claim.observed}\` — verifier evidence: ${v?.evidence ?? "missing"}`;
    })
    .join("\n");

  const repairAttempt = await attemptTwice({
    callAgent,
    site: "repair",
    input: (prior) => ({
      prompt: `${repairPrompt(flaggedText)}${retryNote(prior)}`,
      model: policy.prepare.triageModel,
    }),
    parse: (text) => parseRepair(text, flaggedRows),
    retryParse: true,
    evidence,
  });
  evidence.costUsd += repairAttempt.costUsd;
  if (repairAttempt.text !== "") evidence.repair = repairAttempt.text;
  if (!repairAttempt.ok) return fail(repairAttempt.code, repairAttempt.detail);
  const repairs = repairAttempt.value;
  // The repair must be runnable, or the re-verify would spend a call on a command that cannot
  // start (#401). The same rule the claim table is held to.
  for (const r of repairs) {
    const faults = commandFaults(r.command);
    if (faults.length > 0) {
      return fail(
        "unverifiable",
        `repair for row ${r.row} still cannot run: ${faults.join(", ")} — a command must be one code span, ASCII, and set every variable it reads`,
      );
    }
    // A repair rewrites the command cell, so it is the other way a destructive row could reach the
    // verifier. Checked before the re-verification call, like the first pass (#483).
    const unsafe = commandSafetyFaults([r.command], clone)[0];
    if (unsafe !== undefined) {
      return fail(
        "unverifiable",
        `repair for row ${r.row}: ${unsafe.fault} — the re-verification was not asked to run it`,
      );
    }
  }
  for (const r of repairs) {
    const claim = report.claims[r.row - 1];
    if (claim === undefined) {
      return fail("unverifiable", `repair names row ${r.row}, out of range`);
    }
    claim.command = r.command;
    claim.observed = r.observed;
  }

  const reTable = [
    "| claim | command | observed | verdict |",
    "| --- | --- | --- | --- |",
    ...flaggedRows.map((r) => {
      const c = report.claims[r - 1];
      if (c === undefined) return "";
      return `| ${c.claim} | \`${c.command}\` | ${c.observed} | ${c.verdict}${c.note ?? ""} |`;
    }),
  ].join("\n");

  const reverifyAttempt = await attemptTwice({
    callAgent,
    site: "re-verify",
    input: (prior) => ({
      prompt: `${verifierPrompt(clone, reTable, "")}${retryNote(prior)}`,
      model: policy.prepare.verifierModel,
    }),
    parse: (text) => {
      const normalized = normalizeReverify(parseVerifierBlock(text), flaggedRows);
      if (!normalized.ok) throw new Error(normalized.detail);
      return normalized;
    },
    retryParse: true,
    evidence,
  });
  evidence.costUsd += reverifyAttempt.costUsd;
  // Both attempts go down: the replaced one into `retries.json`, the last reply here, because a
  // refused re-verify is exactly when a reader needs to see what the verifier said (#391).
  if (reverifyAttempt.text !== "") evidence.reverdictsRaw = reverifyAttempt.text;
  if (!reverifyAttempt.ok) return fail(reverifyAttempt.code, reverifyAttempt.detail);
  // The record keeps what the verifier said; the merge takes the normalized, 1..n form.
  evidence.reverdicts = reverifyAttempt.value.raw;
  return {
    repaired: true,
    block: mergeReverify(block, flaggedRows, reverifyAttempt.value.block),
  };
}

/** What the agents actually said, so a refusal can be audited instead of guessed at. */
interface Evidence {
  report?: string;
  verdicts?: unknown;
  verdictsRaw?: string;
  /** The author's repair reply, and the re-verification of the flagged rows alone. */
  repair?: string;
  reverdicts?: unknown;
  /** The last re-verification reply as it arrived, kept even when the site refused (#391). */
  reverdictsRaw?: string;
  /** The merged block after the repair round: what actually decides the ticket (#460). */
  merged?: unknown;
  /** The attempt directory this prepare created; absent when it refused before the clone. */
  attempt?: string;
  /**
   * Spend and retries accrue here rather than in a local of `verifyTicket`: a throw from the
   * clone teardown or the model preflight would otherwise discard what the prepare already paid
   * for, and the record would claim a free run (#373).
   */
  costUsd: number;
  retried: RetriedSite[];
  /** One entry per retried site: the reply or throw that was replaced. */
  rejected: RetryRecord[];
  /** The wall time per site, written to the acceptance/refusal record (#403). */
  durations: SiteWallTimes;
  /** The work each paid attempt cost, written to the same record (#512). */
  calls: CallTelemetry[];
}

/** A retried call and what its first attempt answered, kept so the re-ask is auditable. */
interface RetryRecord {
  site: RetriedSite;
  /** Empty when the first attempt threw before answering. */
  text: string;
  detail: string;
  /** How long the replaced attempt held the batch before it answered or was refused (#403). */
  durationMs?: number;
}

/** The record's evidence files: the report, the verifier block, and any repair-round artifacts. */
function writeEvidence(dir: string, evidence: Evidence): void {
  if (evidence.report !== undefined) writeFileSync(join(dir, "report.md"), evidence.report);
  if (evidence.verdicts !== undefined || evidence.verdictsRaw !== undefined) {
    const body = evidence.verdicts ?? { raw: evidence.verdictsRaw };
    writeFileSync(join(dir, VERDICT_EVIDENCE), `${JSON.stringify(body, null, 2)}\n`);
  }
  if (evidence.repair !== undefined) writeFileSync(join(dir, "repair.md"), evidence.repair);
  if (evidence.reverdicts !== undefined || evidence.reverdictsRaw !== undefined) {
    const body = evidence.reverdicts ?? { raw: evidence.reverdictsRaw };
    writeFileSync(join(dir, REVERDICT_EVIDENCE), `${JSON.stringify(body, null, 2)}\n`);
  }
  if (evidence.merged !== undefined) {
    writeFileSync(join(dir, MERGED_EVIDENCE), `${JSON.stringify(evidence.merged, null, 2)}\n`);
  }
  if (evidence.rejected.length > 0) {
    writeFileSync(join(dir, "retries.json"), `${JSON.stringify(evidence.rejected, null, 2)}\n`);
  }
}

/** The attempt directory for the next prepare on this ticket: `attempts/1`, `attempts/2`, ... */
function nextAttemptDir(ticketDir: string): string {
  const root = join(ticketDir, "attempts");
  const taken = existsSync(root)
    ? readdirSync(root).filter((name) => /^\d+$/.test(name)).length
    : 0;
  const dir = join(root, String(taken + 1));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The issue text an attempt was made against, so two attempts can be told apart (#460). */
/** A recorded reply from an earlier attempt, and which attempt it came from (#466). */
interface Reusable {
  attempt: number;
  text: string;
}

/**
 * The newest earlier attempt whose identity matches this one, with its report if that report parses.
 * A matching identity whose report is missing or unreadable ends the search rather than reaching
 * further back: the newest attempt is the ticket's latest answer, and an older one would hide that
 * the latest attempt's reply could not be read (#466).
 */
function reusableReport(
  attemptDir: string,
  identity: { issue: string; base: string },
): Reusable | undefined {
  const root = dirname(attemptDir);
  const current = Number(basename(attemptDir));
  const earlier = readdirSync(root)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n < current)
    .sort((a, b) => b - a);
  for (const attempt of earlier) {
    const dir = join(root, String(attempt));
    let recorded: { issue?: unknown; base?: unknown };
    try {
      recorded = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8")) as typeof recorded;
    } catch {
      continue; // no identity file, so nothing to compare this attempt against
    }
    if (recorded.issue !== identity.issue || recorded.base !== identity.base) continue;
    try {
      const text = readFileSync(join(dir, "report.md"), "utf8");
      parseTriageReport(text);
      return { attempt, text };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function issueHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** One change the Agent Brief proposes: replace its criterion with `replacement` (#469). */
interface BriefChange {
  criterion: string;
  replacement: string;
}

const AGENT_BRIEF = /^##\s+Agent Brief\s*$/m;
const ACCEPTANCE = /\*\*Acceptance criteria:\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n##\s|$)/;

/**
 * The Agent Brief's Acceptance criteria section is a delta list, not the criteria: "as written in
 * the issue body", then one `<criterion> -> <replacement>` line per change triage wants. Prose and
 * `(none)` are not changes, and a line without the arrow is ignored rather than guessed at.
 */
function briefChanges(comments: readonly { body: string }[]): BriefChange[] {
  const brief = [...comments].reverse().find((comment) => AGENT_BRIEF.test(comment.body));
  const section = brief === undefined ? undefined : ACCEPTANCE.exec(brief.body)?.[1];
  if (section === undefined) return [];
  const changes: BriefChange[] = [];
  for (const line of section.split("\n")) {
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    if (item === null) continue;
    const entry = (item[1] ?? "").trim();
    if (/^\(none\b/i.test(entry)) continue;
    // Split before unbracketing: the line wraps each side in its own span, so stripping the
    // whole line first would leave a stray backtick on each half.
    const parts = entry.split(/\s*->\s*/);
    if (parts.length !== 2) continue;
    changes.push({ criterion: unbracket(parts[0] ?? ""), replacement: unbracket(parts[1] ?? "") });
  }
  return changes;
}

/** A delta line may wrap each side in backticks; the text between them is the criterion. */
function unbracket(text: string): string {
  return text
    .trim()
    .replace(/^`(.*)`$/, "$1")
    .trim();
}

export type FreeGate =
  | { ok: true; snapshot: TicketSnapshot }
  | { ok: false; code: ReasonCode; detail: string; snapshot: TicketSnapshot };

/**
 * The gates that need no clone and no model call: the ticket as filed, its labels, the record on
 * disk, and the body's own Definition of Done. `prepare` asks them before it spends anything, and
 * `check` asks them and stops there, so a repository can learn what a prepare would say without
 * paying for one (#502).
 */
export async function freeGates(
  deps: PrepareDeps,
  policy: BatchPolicy,
  request: BatchRequest,
  ticket: number,
  pinnedKind?: string,
): Promise<FreeGate> {
  const snapshot = await deps.tracker.view(ticket);
  const refuse = (code: ReasonCode, detail: string): FreeGate => ({
    ok: false,
    code,
    detail,
    snapshot,
  });

  if (snapshot.state.toUpperCase() !== "OPEN")
    return refuse("not-needed", `issue is ${snapshot.state}`);
  // A human's "do not automate this" outranks a stale record: check the label before
  // `already-prepared`, but after `not-needed` so a closed ticket stays `not-needed`.
  if (snapshot.labels.includes(policy.labels.skipped)) {
    return refuse("skipped", `labelled ${policy.labels.skipped}`);
  }
  // Either record ends prepare for this ticket: `acceptance.json` is written by an accepted
  // prepare and `run.json` by `run`, so keying on `run.json` alone let a re-prepare of an
  // accepted-but-unrun ticket pay twice and then overwrite the record (#424).
  if (
    existsSync(join(recordRoot(deps), request.id, "tickets", String(ticket), "acceptance.json"))
  ) {
    return refuse("already-prepared", "an acceptance record exists");
  }
  if (existsSync(join(recordRoot(deps), request.id, "tickets", String(ticket), "run.json"))) {
    return refuse("already-prepared", "a run record exists for this ticket");
  }
  // Also after the guard: a record that exists outranks a mistyped flag, and a refusal must
  // not erase it (#424).
  if (pinnedKind !== undefined && !policy.prepare.kinds.includes(pinnedKind)) {
    return refuse(
      "kind-invalid",
      `--kind ${pinnedKind} is not one of ${policy.prepare.kinds.join(", ")}`,
    );
  }

  // Refused before the clone: an undescribed kind does not depend on the ticket, so copying
  // a checkout first spends a copy on a fault the prepare already knows about (#386).
  const kindFault = undescribedKindFault(
    readFileSync(join(PROMPT_DOCS, "triage-prompt.md"), "utf8"),
    policy.prepare.kinds,
  );
  if (kindFault !== undefined) return refuse("infra-error", kindFault);

  // The body owns the DoD (#469), so a body that cannot carry it is refused here, before the clone
  // and the two paid calls: the fold is the same one `acceptCriteria` applies afterwards.
  const bodyDoD = definitionOfDone(snapshot.body);
  if (bodyDoD !== undefined) {
    const folded = acceptCriteria({ criteria: bodyDoD });
    if (!folded.ok) return refuse(folded.code, folded.detail);
    const applied = new Set(folded.criteria);
    // A brief may propose a change, but the change is not applied until the body carries it.
    for (const change of briefChanges(snapshot.comments)) {
      const replacement = normalizeDoD([change.replacement]).criteria[0] ?? change.replacement;
      if (applied.has(replacement)) continue;
      return refuse(
        "dod-unapplied",
        `the agent brief replaces "${change.criterion}" with "${change.replacement}", which the issue body does not state — apply it to the body first`,
      );
    }
  }

  return { ok: true, snapshot };
}

/** Every ticket in the request, through the free gates only: no clone, no model call, no writes. */
export async function check(
  deps: PrepareDeps,
  policy: BatchPolicy,
  request: BatchRequest,
  options: { kind?: string } = {},
): Promise<TicketOutcome[]> {
  if (options.kind !== undefined && typeof request.kind === "object") {
    throw new Error("--kind conflicts with the request's per-ticket kind mapping; drop one");
  }
  const outcomes: TicketOutcome[] = [];
  for (const ticket of request.tickets) {
    try {
      const gate = await freeGates(
        deps,
        policy,
        request,
        ticket,
        pinnedKindFor(request.kind, ticket, options.kind),
      );
      outcomes.push(
        gate.ok
          ? { ticket, ok: true }
          : { ticket, ok: false, code: gate.code, detail: gate.detail },
      );
    } catch (err) {
      // A tracker call that throws is ours: the ticket has not been judged.
      outcomes.push({ ticket, ok: false, code: "infra-error", detail: (err as Error).message });
    }
  }
  return outcomes;
}

async function verifyTicket(
  deps: PrepareDeps,
  policy: BatchPolicy,
  request: BatchRequest,
  ticket: number,
  evidence: Evidence,
  pinnedKind?: string,
  attemptRoot?: string,
): Promise<Verified> {
  const gate = await freeGates(deps, policy, request, ticket, pinnedKind);
  if (!gate.ok) return { ok: false, code: gate.code, detail: gate.detail };
  const snapshot = gate.snapshot;
  // The gate folded it once to refuse a body that cannot carry a DoD; the prompt needs it too, and
  // reading it again from the same body keeps one source (`definitionOfDone` is pure).
  const bodyDoD = definitionOfDone(snapshot.body);

  // The attempt directory is created only once the cheap guards have passed, so a refused
  // `already-prepared` ticket leaves no empty attempt behind (#460). A dry run creates none.
  if (attemptRoot !== undefined) evidence.attempt = nextAttemptDir(attemptRoot);

  const fullMs = policy.prepare.agentTimeoutMinutes * 60_000;
  const clone = await deps.clone.make();
  // The identity ties this attempt to the issue text and tree it checked. It is also what decides
  // whether an earlier attempt's triage reply still answers this one (#466).
  const identity = { issue: issueHash(snapshot.body), base: deps.revision(clone) };
  if (evidence.attempt !== undefined) {
    writeFileSync(
      join(evidence.attempt, "identity.json"),
      `${JSON.stringify(identity, null, 2)}\n`,
    );
  }
  // The clock starts after the clone: copying a checkout is local I/O, not a silent model call,
  // and on a filesystem without clonefile it can dominate a bound it has nothing to do with.
  const deadline = Date.now() + DEADLINE_SHARE * fullMs;
  try {
    // Spend and retries live on `evidence`, which `prepare` keeps after a throw: a fault in the
    // clone teardown or the model preflight must not erase what the prepare already paid for or
    // hide that a call was retried (#373).
    // Set where the reuse decision is made, below; every refusal after that point carries it, so
    // the record says where the reply came from even when the attempt ends in a refusal (#484).
    let triage: { ran: true } | { reusedFrom: number } | undefined;
    const fail = (code: ReasonCode, detail: string): Verified => ({
      ok: false,
      code,
      detail,
      costUsd: evidence.costUsd,
      retried: evidence.retried,
      durations: evidence.durations,
      ...callsField(evidence.calls),
      ...(triage === undefined ? {} : { triage }),
    });

    // One guard for both model calls: a throw here is a connection/timeout/exit fault, which
    // is infra noise, not a verdict on the ticket (#293).
    const callAgent: AgentCall = async (input, site) => {
      // The smaller of the site's permit and what the ticket's prepare has left. A site reached
      // with nothing left is refused, not launched with a zero bound (#403). The permit is rounded
      // because a third of the knob is fractional and a fraction of a millisecond means nothing.
      const bound = Math.min(Math.round(fullMs * SITE_SHARE[site]), deadline - Date.now());
      if (bound <= 0) {
        return { error: `prepare budget spent: ${site} was not called` };
      }
      const started = Date.now();
      try {
        const run = await deps.agent({ ...input, cwd: clone, timeoutMs: bound });
        return { run, durationMs: Date.now() - started };
      } catch (err) {
        return { error: (err as Error).message, durationMs: Date.now() - started };
      }
    };

    // A recorded reply from an attempt that checked the same issue text against the same tree is
    // still the answer this prepare would get, so it is read instead of paid for again (#466). The
    // verifier is the check, not resumable state: it runs either way.
    const reused =
      evidence.attempt === undefined ? undefined : reusableReport(evidence.attempt, identity);
    let report: TriageReport;
    if (reused !== undefined) {
      evidence.report = reused.text;
      report = parseTriageReport(reused.text);
      triage = { reusedFrom: reused.attempt };
    } else {
      const triageAttempt = await attemptTwice({
        callAgent,
        site: "triage",
        input: (prior) => ({
          prompt: `${triagePrompt(ticket, policy.prepare.kinds, pinnedKind, bodyDoD)}${retryNote(prior)}`,
          model: policy.prepare.triageModel,
        }),
        parse: parseTriageReport,
        retryParse: false,
        evidence,
      });
      evidence.costUsd += triageAttempt.costUsd;
      if (triageAttempt.text !== "") evidence.report = triageAttempt.text;
      if (!triageAttempt.ok) return fail(triageAttempt.code, triageAttempt.detail);
      report = triageAttempt.value;
      triage = { ran: true };
    }

    // The body owns the DoD: the reply's copy is a parse artifact, so replacing it here keeps the
    // verifier, the gate, the record and the manifest on one list (#469).
    if (bodyDoD !== undefined) {
      report.criteria = bodyDoD;
      report.criteriaFromBody = true;
    }
    // A "No DoD" reply has no kind to answer with, so its N-code decides first — unless the body
    // states the DoD, which outranks the reply.
    if (bodyDoD === undefined && report.noDod !== undefined) {
      return fail("dod-rejected", `No DoD: ${report.noDod.code} ${report.noDod.reason}`);
    }
    // A caller can pin the kind (rung 4 wants `code-fix` on a ticket triage would call
    // `code-small`); the triage still writes the criteria, it just does not classify.
    const kind = pinnedKind ?? report.kind;
    if (kind === undefined || !policy.prepare.kinds.includes(kind)) {
      return fail(
        "kind-invalid",
        `KIND: ${kind ?? "(missing)"} is not one of ${policy.prepare.kinds.join(", ")}`,
      );
    }

    // A claim row is model-authored from the ticket's own text, so what it would do is checked
    // before the verifier is asked to run it (#483). This is the only place it can be refused in
    // time: every other command check runs after the verifier has already executed the row.
    const unsafe = commandSafetyFaults(
      report.claims.map((c) => c.command),
      clone,
    );
    const firstUnsafe = unsafe[0];
    if (firstUnsafe !== undefined) {
      return fail(
        "unverifiable",
        `row ${firstUnsafe.row}: ${firstUnsafe.fault} — the verifier was not asked to run it`,
      );
    }

    // A cell that kept its delimiters is not a command at all: the shell runs the span as a
    // substitution. That is visible before any call, so it is refused here rather than run and
    // then repaired at two more calls' cost (#520).
    const delimited = report.claims.find((c) => commandFaults(c.command).includes("backtick"));
    if (delimited !== undefined) {
      return fail(
        "unverifiable",
        `row ${delimited.index}: backtick — the verifier was not asked to run it`,
      );
    }

    const verifierAttempt = await attemptTwice({
      callAgent,
      site: "verifier",
      input: (prior) => ({
        prompt: `${verifierPrompt(clone, claimRowsText(report.claims), report.criteria.join("\n"))}${retryNote(prior)}`,
        model: policy.prepare.verifierModel,
      }),
      parse: (text) => {
        const parsed = parseVerifierBlock(text);
        const shape = blockShape(parsed, report.claims.length, report.criteria.length);
        if (shape !== undefined) throw new Error(shape.detail);
        return parsed;
      },
      retryParse: true,
      evidence,
    });
    evidence.costUsd += verifierAttempt.costUsd;
    if (verifierAttempt.text !== "") evidence.verdictsRaw = verifierAttempt.text;
    if (!verifierAttempt.ok) return fail(verifierAttempt.code, verifierAttempt.detail);
    let block = verifierAttempt.value;
    evidence.verdicts = block;
    let verdict = acceptance(report, block);
    // One row named could-not-run ends the batch, but not when the row's own command is the fault:
    // the repair round exists to cure that, and rung 2 shows it does (#401). A could-not-run row
    // whose command is clean keeps today's behaviour — the target is absent, and no repair fixes
    // an absent target (#354).
    const faulted = new Set(dialectFaults(report.claims).map((f) => f.row));
    const dialectFaultsOnly =
      block.couldNotRun.length > 0 && block.couldNotRun.every((r) => faulted.has(r));
    const repairable =
      !verdict.ok &&
      (verdict.code === "verifier-mismatch" ||
        (verdict.code === "harness-error" && dialectFaultsOnly));
    if (repairable) {
      const mismatchRows = block.verdicts.filter((v) => v.verdict === "mismatch").map((v) => v.row);
      const flaggedRows = [...new Set([...mismatchRows, ...block.couldNotRun])].sort(
        (a, b) => a - b,
      );
      if (flaggedRows.length > 0) {
        // One bounded repair round (D1-D3); a DoD-criterion mismatch and every other
        // refusal code skip it.
        const repair = await repairRound(
          callAgent,
          policy,
          clone,
          report,
          block,
          flaggedRows,
          evidence,
        );
        if (!repair.repaired) return fail(repair.code, repair.detail);
        block = repair.block;
        // Both the file and the detail: a post-repair refusal must point at the block it decided
        // on, and that block has to be on disk to be checkable (#460).
        evidence.merged = block;
        verdict = acceptance(report, block, MERGED_EVIDENCE);
      }
    }
    if (!verdict.ok) return fail(verdict.code, verdict.detail);

    const accepted = acceptCriteria(report);
    if (!accepted.ok) return fail(accepted.code, accepted.detail);

    const templatePath = policy.prepare.kindTemplates[kind];
    if (templatePath === undefined) return fail("template-missing", `kind ${kind}`);
    let templateText: string;
    try {
      templateText = readFileSync(resolve(DRIVER_ROOT, templatePath), "utf8");
    } catch {
      return fail("template-missing", templatePath);
    }

    const slug = batchTaskSlug(request.id, ticket);
    let manifestText: string;
    try {
      manifestText = buildManifestText({
        templateText,
        ask: {
          title: snapshot.title,
          description: `Implement the accepted Definition of Done for #${ticket}.`,
          definition_of_done: accepted.criteria,
        },
        sessionId: slug,
      });
    } catch (err) {
      return fail("manifest-invalid", (err as Error).message);
    }

    const unresolved = (await deps.preflight(manifestSlugs(manifestText)))
      .filter((r) => !r.ok)
      .map((r) => r.slug);
    if (unresolved.length > 0) return fail("model-unavailable", unresolved.join(", "));

    assertCommentCriteria(
      commentText({ accepted: true, kind, slug, criteria: accepted.criteria }),
      accepted.criteria,
    );
    return {
      ok: true,
      kind,
      criteria: accepted.criteria,
      slug,
      manifestText,
      costUsd: evidence.costUsd,
      retried: evidence.retried,
      durations: evidence.durations,
      calls: evidence.calls,
      ...(triage === undefined ? {} : { triage }),
    };
  } finally {
    await deps.clone.remove(clone);
  }
}

/** The CLI pin outranks the request's kind; a mapping names each ticket's own (#465). */
function pinnedKindFor(
  requestKind: BatchRequest["kind"],
  ticket: number,
  flag: string | undefined,
): string | undefined {
  if (flag !== undefined) return flag;
  if (typeof requestKind === "string") return requestKind;
  return requestKind?.[ticket];
}

export async function prepare(
  deps: PrepareDeps,
  policy: BatchPolicy,
  request: BatchRequest,
  options: { dryRun?: boolean; kind?: string; breakLock?: boolean } = {},
): Promise<TicketOutcome[]> {
  // A pin and a per-ticket mapping cannot both decide the kind: silently preferring either would
  // apply a template nobody asked for (#465). Refused before any ticket spends.
  if (options.kind !== undefined && typeof request.kind === "object") {
    throw new Error("--kind conflicts with the request's per-ticket kind mapping; drop one");
  }
  const outcomes: TicketOutcome[] = [];

  for (const ticket of request.tickets) {
    const evidence: Evidence = { costUsd: 0, retried: [], rejected: [], durations: {}, calls: [] };
    const dir = join(recordRoot(deps), request.id, "tickets", String(ticket));
    // Taken before the record check, because that check is what two processes race on (#427).
    // A dry run writes nothing, so it locks nothing either.
    const locked =
      options.dryRun === true
        ? undefined
        : acquirePrepareLock(prepareLockPath(join(recordRoot(deps), request.id), ticket), {
            breakLock: options.breakLock,
          });
    if (locked !== undefined && !locked.ok) {
      outcomes.push({
        ticket,
        ok: false,
        code: "already-prepared",
        detail: locked.detail,
        costUsd: 0,
        retried: [],
        durations: {},
        calls: [],
      });
      continue;
    }
    try {
      let verified: Verified;
      try {
        verified = await verifyTicket(
          deps,
          policy,
          request,
          ticket,
          evidence,
          pinnedKindFor(request.kind, ticket, options.kind),
          // Each attempt owns its directory, so a later attempt cannot overwrite an earlier one;
          // a dry run writes nothing and gets none (#460).
          options.dryRun === true ? undefined : dir,
        );
      } catch (err) {
        // Everything a verdict cannot explain — the tracker, the clone, a model call that
        // threw outside its own guard — is infra, not a judgement on the ticket (#299).
        const failed: Extract<Verified, { ok: false }> = {
          ok: false,
          code: "infra-error",
          detail: (err as Error).message,
          retried: evidence.retried,
          durations: evidence.durations,
          ...callsField(evidence.calls),
        };
        // Absent is not zero: a throw before the first paid call spent nothing measurable, and a
        // recorded `0` would claim a measurement the prepare never made (#384).
        if (evidence.costUsd > 0) failed.costUsd = evidence.costUsd;
        verified = failed;
      }

      const outcome: TicketOutcome = verified.ok
        ? {
            ticket,
            ok: true,
            kind: verified.kind,
            criteria: verified.criteria,
            costUsd: verified.costUsd,
            slug: verified.slug,
            retried: verified.retried,
            durations: verified.durations,
            ...callsField(verified.calls),
            ...(verified.triage === undefined ? {} : { triage: verified.triage }),
          }
        : {
            ticket,
            ok: false,
            code: verified.code,
            detail: verified.detail,
            costUsd: verified.costUsd,
            retried: verified.retried ?? [],
            durations: verified.durations,
            ...callsField(verified.calls),
            ...(verified.triage === undefined ? {} : { triage: verified.triage }),
          };
      outcomes.push(outcome);

      if (options.dryRun === true) continue;
      const attempt = evidence.attempt;
      mkdirSync(dir, { recursive: true });
      // The evidence goes down for refusals too: that is when it is worth reading. A refusal
      // before the clone has no attempt, and therefore no evidence, but still gets its record.
      if (attempt !== undefined) writeEvidence(attempt, evidence);

      // The record states what this attempt decided, and only that: each path clears the
      // other's file, so one prepare cannot claim two outcomes (#247). An acceptance already
      // on disk is a different attempt's record: a refusal leaves it byte-identical, writes no
      // refusal, and says nothing on the ticket, so guard order cannot destroy a record (#424).
      if (!verified.ok) {
        if (existsSync(join(dir, "acceptance.json"))) continue;
        rmSync(join(dir, "acceptance.json"), { force: true });
        const record = `${JSON.stringify(outcome, null, 2)}\n`;
        // The root file is what `run` and `status` read; the attempt copy is what history keeps.
        writeFileSync(join(dir, "refusal.json"), record);
        if (attempt !== undefined) writeFileSync(join(attempt, "decision.json"), record);
        await deps.tracker.upsertMarkerComment(
          ticket,
          markerFor(request.id, ticket),
          commentText({
            accepted: false,
            code: verified.code,
            detail: verified.detail,
            retried: verified.retried ?? [],
          }),
        );
        // A refused ticket that keeps wearing the ready label is a trap: the label is what a human
        // and `run` read as grabbable, and a refusal caused by the ticket will not go away by
        // retrying. Off unless the policy asks, because another tracker's label may mean something
        // this driver must not rewrite (#502).
        if (policy.labels.onRefusal && TICKET_FAULT_CODES.has(verified.code)) {
          await deps.tracker.removeLabel(ticket, policy.labels.ready);
          await deps.tracker.addLabel(ticket, policy.labels.needsInfo);
        }
        continue;
      }

      rmSync(join(dir, "refusal.json"), { force: true });
      const record = `${JSON.stringify(
        {
          ticket,
          kind: verified.kind,
          slug: verified.slug,
          criteria: verified.criteria,
          costUsd: verified.costUsd,
          retried: verified.retried ?? [],
          durations: verified.durations,
          ...callsField(verified.calls),
          ...(verified.triage === undefined ? {} : { triage: verified.triage }),
        },
        null,
        2,
      )}\n`;
      writeFileSync(join(dir, "acceptance.json"), record);
      if (attempt !== undefined) writeFileSync(join(attempt, "decision.json"), record);

      // D9: the checkout task dir is created by `run` when the ticket actually starts,
      // not here — a session.yaml in the task dir must never mean "queued, never run".
      writeFileSync(join(dir, "manifest.yaml"), verified.manifestText);

      await deps.tracker.upsertMarkerComment(
        ticket,
        markerFor(request.id, ticket),
        commentText({
          accepted: true,
          kind: verified.kind,
          slug: verified.slug,
          criteria: verified.criteria,
          retried: verified.retried ?? [],
        }),
      );
      await deps.tracker.addLabel(ticket, policy.labels.ready);
    } finally {
      locked?.lock.release();
    }
  }
  return outcomes;
}
