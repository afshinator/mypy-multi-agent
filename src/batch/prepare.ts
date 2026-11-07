/**
 * The order here is the safety property. Every validation that can refuse a ticket runs
 * before the first fact is published: the manifest is built and its models are resolved
 * before the comment exists, and the comment's criteria are proven equal to the manifest's
 * before `ready-for-agent` goes on. Reverse two steps and a ticket can be labelled ready
 * with a manifest that will not launch — and every unit test in the repo still passes.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYamlText } from "yaml";
import { type AgentRun, extractPromptBlock } from "./agent";
import { normalizeDoD } from "./dod";
import { buildManifestText } from "./manifest";
import { DEFAULT_BATCH_DIR, DEFAULT_TASK_DIR } from "./paths";
import type { BatchPolicy } from "./policy";
import {
  acceptance,
  blockShape,
  commandFaults,
  dialectFaults,
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
import type { Tracker } from "./tracker";

/** The four paid agent calls a prepare makes, named so a retried one is visible in the record. */
export type RetriedSite = "triage" | "verifier" | "repair" | "re-verify";

/** The retry trail as one label, empty when nothing was retried; each caller adds its separator (#389). */
export function retriedLabel(sites: readonly RetriedSite[]): string {
  return sites.length === 0 ? "" : `retried: ${sites.join(", ")}`;
}

/** The wall time each site's deciding call took; a site that was never called is absent, not zero. */
type SiteWallTimes = Partial<Record<RetriedSite, number>>;

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

export type ReasonCode =
  | "not-needed"
  | "skipped"
  | "unverifiable"
  | "infra-error"
  | "harness-error"
  | "verifier-mismatch"
  | "dod-rejected"
  | "kind-invalid"
  | "template-missing"
  | "already-prepared"
  | "manifest-invalid"
  | "model-unavailable";

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
}

type Verified =
  | {
      ok: false;
      code: ReasonCode;
      detail: string;
      costUsd?: number;
      retried?: RetriedSite[];
      durations?: SiteWallTimes;
    }
  | {
      ok: true;
      kind: string;
      criteria: string[];
      slug: string;
      manifestText: string;
      costUsd: number;
      retried: RetriedSite[];
      durations: SiteWallTimes;
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
  }) => Promise<{ text: string; costUsd: number }>;
  preflight: (slugs: string[]) => Promise<{ slug: string; ok: boolean }[]>;
  clone: { make(): Promise<string>; remove(dir: string): Promise<void> };
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
    return `prepare refused this ticket: **${input.code}**\n\n${input.detail ?? ""}`.trim() + note;
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

function triagePrompt(ticket: number, kinds: string[], pinnedKind?: string): string {
  const doc = readFileSync(join(PROMPT_DOCS, "triage-prompt.md"), "utf8");
  const body = extractPromptBlock(doc).replaceAll("#NNN", `#${ticket}`);
  const fault = undescribedKindFault(doc, pinnedKind === undefined ? kinds : [pinnedKind]);
  if (fault !== undefined) throw new Error(fault);
  const lines = kindNoteLines(doc);
  const kept = lines.filter((line) => {
    const kind = KIND_LINE.exec(line)?.[1];
    return kind === undefined || kinds.includes(kind);
  });
  if (pinnedKind !== undefined) {
    // Decided by the caller: asking for a classification invites a different answer.
    return [
      body,
      "",
      "KIND",
      `The kind is already decided: ${pinnedKind}. Do not write a KIND line.`,
      "",
      ...kept,
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
    "",
  ].join("\n");
}

function verifierPrompt(clone: string, claimsText: string, dodText: string): string {
  const doc = readFileSync(join(PROMPT_DOCS, "triage-verifier.md"), "utf8");
  return extractPromptBlock(doc)
    .replaceAll("<CLONE ROOT>", clone)
    .replace("<paste the report's claim table here, one row per line>", claimsText)
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
        `repair for row ${r.row} still cannot run: ${faults.join(", ")} — a command must be ASCII and set every variable it reads`,
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
      return `| ${c.claim} | \`${c.command}\` | ${c.observed} | ${c.verdict} |`;
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
  if (evidence.rejected.length > 0) {
    writeFileSync(join(dir, "retries.json"), `${JSON.stringify(evidence.rejected, null, 2)}\n`);
  }
}

async function verifyTicket(
  deps: PrepareDeps,
  policy: BatchPolicy,
  request: BatchRequest,
  ticket: number,
  evidence: Evidence,
  pinnedKind?: string,
): Promise<Verified> {
  // A pinned kind that the policy does not offer is a caller's mistake, so it is refused
  // before the clone and any model call (#419 follow-up).
  const snapshot = await deps.tracker.view(ticket);
  if (snapshot.state.toUpperCase() !== "OPEN") {
    return { ok: false, code: "not-needed", detail: `issue is ${snapshot.state}` };
  }
  // A human's "do not automate this" outranks a stale record: check the label before
  // `already-prepared`, but after `not-needed` so a closed ticket stays `not-needed`.
  if (snapshot.labels.includes("not-batched")) {
    return { ok: false, code: "skipped", detail: "labelled not-batched" };
  }
  // Either record ends prepare for this ticket: `acceptance.json` is written by an accepted
  // prepare and `run.json` by `run`, so keying on `run.json` alone let a re-prepare of an
  // accepted-but-unrun ticket pay twice and then overwrite the record (#424).
  if (
    existsSync(join(recordRoot(deps), request.id, "tickets", String(ticket), "acceptance.json"))
  ) {
    return { ok: false, code: "already-prepared", detail: "an acceptance record exists" };
  }
  if (existsSync(join(recordRoot(deps), request.id, "tickets", String(ticket), "run.json"))) {
    return { ok: false, code: "already-prepared", detail: "a run record exists for this ticket" };
  }
  // Also after the guard: a record that exists outranks a mistyped flag, and a refusal must
  // not erase it (#424).
  if (pinnedKind !== undefined && !policy.prepare.kinds.includes(pinnedKind)) {
    return {
      ok: false,
      code: "kind-invalid",
      detail: `--kind ${pinnedKind} is not one of ${policy.prepare.kinds.join(", ")}`,
    };
  }

  // Refused before the clone: an undescribed kind does not depend on the ticket, so copying
  // a checkout first spends a copy on a fault the prepare already knows about (#386).
  const kindFault = undescribedKindFault(
    readFileSync(join(PROMPT_DOCS, "triage-prompt.md"), "utf8"),
    policy.prepare.kinds,
  );
  if (kindFault !== undefined) return { ok: false, code: "infra-error", detail: kindFault };

  const fullMs = policy.prepare.agentTimeoutMinutes * 60_000;
  const clone = await deps.clone.make();
  // The clock starts after the clone: copying a checkout is local I/O, not a silent model call,
  // and on a filesystem without clonefile it can dominate a bound it has nothing to do with.
  const deadline = Date.now() + DEADLINE_SHARE * fullMs;
  try {
    // Spend and retries live on `evidence`, which `prepare` keeps after a throw: a fault in the
    // clone teardown or the model preflight must not erase what the prepare already paid for or
    // hide that a call was retried (#373).
    const fail = (code: ReasonCode, detail: string): Verified => ({
      ok: false,
      code,
      detail,
      costUsd: evidence.costUsd,
      retried: evidence.retried,
      durations: evidence.durations,
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

    const triageAttempt = await attemptTwice({
      callAgent,
      site: "triage",
      input: (prior) => ({
        prompt: `${triagePrompt(ticket, policy.prepare.kinds, pinnedKind)}${retryNote(prior)}`,
        model: policy.prepare.triageModel,
      }),
      parse: parseTriageReport,
      retryParse: false,
      evidence,
    });
    evidence.costUsd += triageAttempt.costUsd;
    if (triageAttempt.text !== "") evidence.report = triageAttempt.text;
    if (!triageAttempt.ok) return fail(triageAttempt.code, triageAttempt.detail);
    const report = triageAttempt.value;

    // A "No DoD" reply has no kind to answer with, so its N-code decides first.
    if (report.noDod !== undefined) {
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

    const verifierAttempt = await attemptTwice({
      callAgent,
      site: "verifier",
      input: (prior) => ({
        prompt: `${verifierPrompt(clone, report.claimsText, report.criteria.join("\n"))}${retryNote(prior)}`,
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
        verdict = acceptance(report, block);
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

    const slug = `b-${request.id}-t${ticket}`;
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
    };
  } finally {
    await deps.clone.remove(clone);
  }
}

export async function prepare(
  deps: PrepareDeps,
  policy: BatchPolicy,
  request: BatchRequest,
  options: { dryRun?: boolean; kind?: string } = {},
): Promise<TicketOutcome[]> {
  const outcomes: TicketOutcome[] = [];

  for (const ticket of request.tickets) {
    const evidence: Evidence = { costUsd: 0, retried: [], rejected: [], durations: {} };
    let verified: Verified;
    try {
      verified = await verifyTicket(deps, policy, request, ticket, evidence, options.kind);
    } catch (err) {
      // Everything a verdict cannot explain — the tracker, the clone, a model call that
      // threw outside its own guard — is infra, not a judgement on the ticket (#299).
      const failed: Extract<Verified, { ok: false }> = {
        ok: false,
        code: "infra-error",
        detail: (err as Error).message,
        retried: evidence.retried,
        durations: evidence.durations,
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
        }
      : {
          ticket,
          ok: false,
          code: verified.code,
          detail: verified.detail,
          costUsd: verified.costUsd,
          retried: verified.retried ?? [],
          durations: verified.durations,
        };
    outcomes.push(outcome);

    if (options.dryRun === true) continue;

    const dir = join(recordRoot(deps), request.id, "tickets", String(ticket));
    mkdirSync(dir, { recursive: true });
    // The evidence goes down for refusals too: that is when it is worth reading.
    writeEvidence(dir, evidence);

    // The record states what this attempt decided, and only that: each path clears the
    // other's file, so one prepare cannot claim two outcomes (#247). An acceptance already
    // on disk is a different attempt's record: a refusal leaves it byte-identical, writes no
    // refusal, and says nothing on the ticket, so guard order cannot destroy a record (#424).
    if (!verified.ok) {
      if (existsSync(join(dir, "acceptance.json"))) continue;
      rmSync(join(dir, "acceptance.json"), { force: true });
      writeFileSync(join(dir, "refusal.json"), `${JSON.stringify(outcome, null, 2)}\n`);
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
      continue;
    }

    rmSync(join(dir, "refusal.json"), { force: true });
    writeFileSync(
      join(dir, "acceptance.json"),
      `${JSON.stringify(
        {
          ticket,
          kind: verified.kind,
          slug: verified.slug,
          criteria: verified.criteria,
          costUsd: verified.costUsd,
          retried: verified.retried ?? [],
          durations: verified.durations,
        },
        null,
        2,
      )}\n`,
    );

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
    await deps.tracker.addLabel(ticket, "ready-for-agent");
  }
  return outcomes;
}
