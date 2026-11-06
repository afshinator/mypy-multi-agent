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
  mergeReverify,
  parseRepair,
  parseTriageReport,
  parseVerifierBlock,
  type TriageReport,
  VERDICT_EVIDENCE,
  type VerifierBlock,
} from "./report";
import type { BatchRequest } from "./request";
import type { Tracker } from "./tracker";

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
}

type Verified =
  | { ok: false; code: ReasonCode; detail: string; costUsd?: number }
  | {
      ok: true;
      kind: string;
      criteria: string[];
      slug: string;
      manifestText: string;
      costUsd: number;
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
  | { accepted: true; kind: string; slug?: string; criteria: string[] }
  | { accepted: false; code: string; detail?: string };

/** The writeback body: one `- ` line per criterion, so a dropped criterion is visible. */
export function commentText(input: CommentInput): string {
  if (!input.accepted) {
    return `prepare refused this ticket: **${input.code}**\n\n${input.detail ?? ""}`.trim();
  }
  const lines = [`kind: ${input.kind}`];
  if (input.slug !== undefined) lines.push(`run: ${input.slug}`);
  lines.push("", "Definition of Done:", ...input.criteria.map((c) => `- ${c}`));
  return lines.join("\n");
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

/**
 * What each kind is for. The KIND line otherwise offers bare names, and a name like
 * "writer-solo" reads as the smaller writer to any agent that has never seen the templates —
 * a policy offering both kinds then picks one at random.
 */
const KIND_NOTES: Record<string, string> = {
  "code-fix": "two engineers implement the DoD in parallel; a read-only reviewer attests",
  "code-small": "one implementer plus a read-only attester, for a change too small to split",
  writer: "one prose writer plus a read-only attester, for a docs or research ticket",
  "writer-solo":
    "one prose writer that also attests its own work, for a docs or research ticket too small for a separate reviewer",
};

function triagePrompt(ticket: number, kinds: string[]): string {
  const doc = readFileSync(join(PROMPT_DOCS, "triage-prompt.md"), "utf8");
  const body = extractPromptBlock(doc).replaceAll("#NNN", `#${ticket}`);
  const choices = kinds.join(", ");
  const notes = kinds
    .map((kind) => `- ${kind}: ${KIND_NOTES[kind] ?? "no shipped description"}`)
    .join("\n");
  return [
    body,
    "\nKIND",
    `End your reply with one line, exactly: \`KIND: <one of ${choices}>\`.`,
    "",
    "The kinds:",
    notes,
    "A criterion whose proof is a judgement — does this recommendation follow from what the",
    "repository has — needs the independent attester; `-solo` kinds are for criteria a command",
    "settles on its own.",
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

type AgentCall = (input: {
  prompt: string;
  model: string;
}) => Promise<{ run: AgentRun } | { error: string }>;

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
  | { repaired: true; block: VerifierBlock; costUsd: number }
  | { repaired: false; code: ReasonCode; detail: string; costUsd: number }
> {
  let costUsd = 0;
  const fail = (code: ReasonCode, detail: string) => ({
    repaired: false as const,
    code,
    detail,
    costUsd,
  });

  const flaggedText = flaggedRows
    .map((r) => {
      const claim = report.claims[r - 1];
      if (claim === undefined) return `row ${r}: (missing claim)`;
      const v = block.verdicts.find((x) => x.row === r);
      return `row ${r}: command \`${claim.command}\` observed \`${claim.observed}\` — verifier evidence: ${v?.evidence ?? "missing"}`;
    })
    .join("\n");

  const repairCall = await callAgent({
    prompt: repairPrompt(flaggedText),
    model: policy.prepare.triageModel,
  });
  if ("error" in repairCall) return fail("infra-error", repairCall.error);
  costUsd += repairCall.run.costUsd;
  evidence.repair = repairCall.run.text;

  let repairs: ReturnType<typeof parseRepair>;
  try {
    repairs = parseRepair(repairCall.run.text, flaggedRows);
  } catch (err) {
    return fail("unverifiable", (err as Error).message);
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

  const reverifyCall = await callAgent({
    prompt: verifierPrompt(clone, reTable, ""),
    model: policy.prepare.verifierModel,
  });
  if ("error" in reverifyCall) return fail("infra-error", reverifyCall.error);
  costUsd += reverifyCall.run.costUsd;

  let reblock: ReturnType<typeof parseVerifierBlock>;
  try {
    reblock = parseVerifierBlock(reverifyCall.run.text);
  } catch (err) {
    return fail("unverifiable", (err as Error).message);
  }
  evidence.reverdicts = reblock;
  return { repaired: true, block: mergeReverify(block, flaggedRows, reblock), costUsd };
}

/** What the agents actually said, so a refusal can be audited instead of guessed at. */
interface Evidence {
  report?: string;
  verdicts?: unknown;
  verdictsRaw?: string;
  /** The author's repair reply, and the re-verification of the flagged rows alone. */
  repair?: string;
  reverdicts?: unknown;
}

/** The record's evidence files: the report, the verifier block, and any repair-round artifacts. */
function writeEvidence(dir: string, evidence: Evidence): void {
  if (evidence.report !== undefined) writeFileSync(join(dir, "report.md"), evidence.report);
  if (evidence.verdicts !== undefined || evidence.verdictsRaw !== undefined) {
    const body = evidence.verdicts ?? { raw: evidence.verdictsRaw };
    writeFileSync(join(dir, VERDICT_EVIDENCE), `${JSON.stringify(body, null, 2)}\n`);
  }
  if (evidence.repair !== undefined) writeFileSync(join(dir, "repair.md"), evidence.repair);
  if (evidence.reverdicts !== undefined) {
    writeFileSync(
      join(dir, "reverdicts.json"),
      `${JSON.stringify(evidence.reverdicts, null, 2)}\n`,
    );
  }
}

async function verifyTicket(
  deps: PrepareDeps,
  policy: BatchPolicy,
  request: BatchRequest,
  ticket: number,
  evidence: Evidence,
): Promise<Verified> {
  const snapshot = await deps.tracker.view(ticket);
  if (snapshot.state.toUpperCase() !== "OPEN") {
    return { ok: false, code: "not-needed", detail: `issue is ${snapshot.state}` };
  }
  // A human's "do not automate this" outranks a stale run record: check the label before
  // `already-prepared`, but after `not-needed` so a closed ticket stays `not-needed`.
  if (snapshot.labels.includes("not-batched")) {
    return { ok: false, code: "skipped", detail: "labelled not-batched" };
  }
  if (existsSync(join(recordRoot(deps), request.id, "tickets", String(ticket), "run.json"))) {
    return { ok: false, code: "already-prepared", detail: "a run record exists for this ticket" };
  }

  const timeoutMs = policy.prepare.agentTimeoutMinutes * 60_000;
  const clone = await deps.clone.make();
  try {
    let costUsd = 0;
    const fail = (code: ReasonCode, detail: string): Verified => ({
      ok: false,
      code,
      detail,
      costUsd,
    });

    // One guard for both model calls: a throw here is a connection/timeout/exit fault, which
    // is infra noise, not a verdict on the ticket (#293).
    const callAgent = async (input: {
      prompt: string;
      model: string;
    }): Promise<{ run: AgentRun } | { error: string }> => {
      try {
        return { run: await deps.agent({ ...input, cwd: clone, timeoutMs }) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    };

    const triageCall = await callAgent({
      prompt: triagePrompt(ticket, policy.prepare.kinds),
      model: policy.prepare.triageModel,
    });
    if ("error" in triageCall) return fail("infra-error", triageCall.error);
    const triage = triageCall.run;
    costUsd += triage.costUsd;
    evidence.report = triage.text;

    let report: ReturnType<typeof parseTriageReport>;
    try {
      report = parseTriageReport(triage.text);
    } catch (err) {
      return fail("unverifiable", (err as Error).message);
    }

    // A "No DoD" reply has no kind to answer with, so its N-code decides first.
    if (report.noDod !== undefined) {
      return fail("dod-rejected", `No DoD: ${report.noDod.code} ${report.noDod.reason}`);
    }
    const kind = report.kind;
    if (kind === undefined || !policy.prepare.kinds.includes(kind)) {
      return fail(
        "kind-invalid",
        `KIND: ${kind ?? "(missing)"} is not one of ${policy.prepare.kinds.join(", ")}`,
      );
    }

    const verifierCall = await callAgent({
      prompt: verifierPrompt(clone, report.claimsText, report.criteria.join("\n")),
      model: policy.prepare.verifierModel,
    });
    if ("error" in verifierCall) return fail("infra-error", verifierCall.error);
    const verifier = verifierCall.run;
    costUsd += verifier.costUsd;
    evidence.verdictsRaw = verifier.text;

    let block: ReturnType<typeof parseVerifierBlock>;
    try {
      block = parseVerifierBlock(verifier.text);
    } catch (err) {
      return fail("unverifiable", (err as Error).message);
    }
    evidence.verdicts = block;
    let verdict = acceptance(report, block);
    if (!verdict.ok && verdict.code === "verifier-mismatch") {
      const flaggedRows = block.verdicts.filter((v) => v.verdict === "mismatch").map((v) => v.row);
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
        costUsd += repair.costUsd;
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
      costUsd,
    };
  } finally {
    await deps.clone.remove(clone);
  }
}

export async function prepare(
  deps: PrepareDeps,
  policy: BatchPolicy,
  request: BatchRequest,
  options: { dryRun?: boolean } = {},
): Promise<TicketOutcome[]> {
  const outcomes: TicketOutcome[] = [];

  for (const ticket of request.tickets) {
    const evidence: Evidence = {};
    let verified: Verified;
    try {
      verified = await verifyTicket(deps, policy, request, ticket, evidence);
    } catch (err) {
      // Everything a verdict cannot explain — the tracker, the clone, a model call that
      // threw outside its own guard — is infra, not a judgement on the ticket (#299).
      verified = { ok: false, code: "infra-error", detail: (err as Error).message };
    }

    const outcome: TicketOutcome = verified.ok
      ? {
          ticket,
          ok: true,
          kind: verified.kind,
          criteria: verified.criteria,
          costUsd: verified.costUsd,
          slug: verified.slug,
        }
      : {
          ticket,
          ok: false,
          code: verified.code,
          detail: verified.detail,
          costUsd: verified.costUsd,
        };
    outcomes.push(outcome);

    if (options.dryRun === true) continue;

    const dir = join(recordRoot(deps), request.id, "tickets", String(ticket));
    mkdirSync(dir, { recursive: true });
    // The evidence goes down for refusals too: that is when it is worth reading.
    writeEvidence(dir, evidence);

    // The record states what this run decided, and only that: each path clears the
    // other's file, so a re-prepared ticket cannot claim two outcomes at once (#247).
    if (!verified.ok) {
      rmSync(join(dir, "acceptance.json"), { force: true });
      writeFileSync(join(dir, "refusal.json"), `${JSON.stringify(outcome, null, 2)}\n`);
      await deps.tracker.upsertMarkerComment(
        ticket,
        markerFor(request.id, ticket),
        commentText({ accepted: false, code: verified.code, detail: verified.detail }),
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
      }),
    );
    await deps.tracker.addLabel(ticket, "ready-for-agent");
  }
  return outcomes;
}
