/**
 * The order here is the safety property. Every validation that can refuse a ticket runs
 * before the first fact is published: the manifest is built and its models are resolved
 * before the comment exists, and the comment's criteria are proven equal to the manifest's
 * before `ready-for-agent` goes on. Reverse two steps and a ticket can be labelled ready
 * with a manifest that will not launch — and every unit test in the repo still passes.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYamlText } from "yaml";
import { extractPromptBlock } from "./agent";
import { normalizeDoD } from "./dod";
import { buildManifestText } from "./manifest";
import type { BatchPolicy } from "./policy";
import { acceptance, parseTriageReport, parseVerifierBlock } from "./report";
import type { BatchRequest } from "./request";
import type { Tracker } from "./tracker";

export type ReasonCode =
  | "not-needed"
  | "unverifiable"
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
  | { ok: true; inline: true; criteria: string[]; costUsd: number }
  | {
      ok: true;
      inline: false;
      kind: string;
      criteria: string[];
      slug: string;
      manifestText: string;
      costUsd: number;
    };

export interface PrepareDeps {
  /** Where `batches/` and `mypi-tasks/` live. */
  cwd: string;
  /** Where `docs/` and `templates/` live; defaults to `cwd`. */
  repoRoot?: string;
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

const PROMPT_DOCS = "docs/explorations/triage-automation";

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

function triagePrompt(repoRoot: string, ticket: number, kinds: string[]): string {
  const doc = readFileSync(join(repoRoot, PROMPT_DOCS, "triage-prompt.md"), "utf8");
  const body = extractPromptBlock(doc).replaceAll("#NNN", `#${ticket}`);
  const choices = [...kinds, "inline"].join(", ");
  return `${body}\n\nKIND\nEnd your reply with one line, exactly: \`KIND: <one of ${choices}>\`. Use \`inline\` when the change is small enough that a run is not worth it.\n`;
}

function verifierPrompt(repoRoot: string, clone: string, claimsText: string): string {
  const doc = readFileSync(join(repoRoot, PROMPT_DOCS, "triage-verifier.md"), "utf8");
  return extractPromptBlock(doc)
    .replaceAll("<CLONE ROOT>", clone)
    .replace("<paste the report's claim table here, one row per line>", claimsText);
}

/** What the agents actually said, so a refusal can be audited instead of guessed at. */
interface Evidence {
  report?: string;
  verdicts?: unknown;
  verdictsRaw?: string;
}

async function verifyTicket(
  deps: PrepareDeps,
  policy: BatchPolicy,
  request: BatchRequest,
  ticket: number,
  repoRoot: string,
  evidence: Evidence,
): Promise<Verified> {
  const snapshot = await deps.tracker.view(ticket);
  if (snapshot.state.toUpperCase() !== "OPEN") {
    return { ok: false, code: "not-needed", detail: `issue is ${snapshot.state}` };
  }
  if (existsSync(join(deps.cwd, "batches", request.id, "tickets", String(ticket), "run.json"))) {
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

    const triage = await deps.agent({
      prompt: triagePrompt(repoRoot, ticket, policy.prepare.kinds),
      model: policy.prepare.triageModel,
      cwd: clone,
      timeoutMs,
    });
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
    if (kind === undefined || (kind !== "inline" && !policy.prepare.kinds.includes(kind))) {
      return fail(
        "kind-invalid",
        `KIND: ${kind ?? "(missing)"} is not one of ${[...policy.prepare.kinds, "inline"].join(", ")}`,
      );
    }
    if (kind === "inline") {
      // Inline publishes a DoD without a run, so it takes the same criteria path.
      const accepted = acceptCriteria(report);
      if (!accepted.ok) return fail(accepted.code, accepted.detail);
      assertCommentCriteria(
        commentText({ accepted: true, kind: "inline", criteria: accepted.criteria }),
        accepted.criteria,
      );
      return { ok: true, inline: true, criteria: accepted.criteria, costUsd };
    }

    const verifier = await deps.agent({
      prompt: verifierPrompt(repoRoot, clone, report.claimsText),
      model: policy.prepare.verifierModel,
      cwd: clone,
      timeoutMs,
    });
    costUsd += verifier.costUsd;
    evidence.verdictsRaw = verifier.text;

    let block: ReturnType<typeof parseVerifierBlock>;
    try {
      block = parseVerifierBlock(verifier.text);
    } catch (err) {
      return fail("unverifiable", (err as Error).message);
    }
    evidence.verdicts = block;
    const verdict = acceptance(report, block);
    if (!verdict.ok) return fail(verdict.code, verdict.detail);

    const accepted = acceptCriteria(report);
    if (!accepted.ok) return fail(accepted.code, accepted.detail);

    const templatePath = policy.prepare.kindTemplates[kind];
    if (templatePath === undefined) return fail("template-missing", `kind ${kind}`);
    let templateText: string;
    try {
      templateText = readFileSync(resolve(repoRoot, templatePath), "utf8");
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
      inline: false,
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
  const repoRoot = deps.repoRoot ?? deps.cwd;
  const outcomes: TicketOutcome[] = [];

  for (const ticket of request.tickets) {
    const evidence: Evidence = {};
    let verified: Verified;
    try {
      verified = await verifyTicket(deps, policy, request, ticket, repoRoot, evidence);
    } catch (err) {
      verified = { ok: false, code: "unverifiable", detail: (err as Error).message };
    }

    const outcome: TicketOutcome = verified.ok
      ? {
          ticket,
          ok: true,
          kind: verified.inline ? "inline" : verified.kind,
          criteria: verified.criteria,
          costUsd: verified.costUsd,
          ...(verified.inline ? {} : { slug: verified.slug }),
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

    const dir = join(deps.cwd, "batches", request.id, "tickets", String(ticket));
    mkdirSync(dir, { recursive: true });
    // The evidence goes down for refusals too: that is when it is worth reading.
    if (evidence.report !== undefined) writeFileSync(join(dir, "report.md"), evidence.report);
    if (evidence.verdicts !== undefined || evidence.verdictsRaw !== undefined) {
      const body = evidence.verdicts ?? { raw: evidence.verdictsRaw };
      writeFileSync(join(dir, "verdicts.json"), `${JSON.stringify(body, null, 2)}\n`);
    }

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
          kind: verified.inline ? "inline" : verified.kind,
          ...(verified.inline ? {} : { slug: verified.slug }),
          criteria: verified.criteria,
          costUsd: verified.costUsd,
        },
        null,
        2,
      )}\n`,
    );

    if (verified.inline) {
      await deps.tracker.upsertMarkerComment(
        ticket,
        markerFor(request.id, ticket),
        commentText({ accepted: true, kind: "inline", criteria: verified.criteria }),
      );
      continue;
    }

    writeFileSync(join(dir, "manifest.yaml"), verified.manifestText);
    const taskDir = join(deps.cwd, "mypi-tasks", verified.slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "session.yaml"), verified.manifestText);

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
