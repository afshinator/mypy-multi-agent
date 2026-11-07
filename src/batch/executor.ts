/**
 * Serial execution of one batch, with the lifecycle the runtime does not own.
 *
 * A successful run never exits pi and never closes its workspace, and nothing inside the run
 * bounds its wall clock (design W3/W4). So "finished" is a property of the filesystem —
 * `run-details/final.md` present, complete, newer than the launch, and unchanged across two
 * reads, after which the transient `.peer-*.json` files are gone — and the workspace is closed
 * here on every path, including the failing ones.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYamlText } from "yaml";
import { parseSessionConfig } from "../contracts/session-schema";
import { DEFAULT_BATCH_DIR } from "./paths";
import type { BatchPolicy } from "./policy";
import { manifestSlugs } from "./prepare";
import { EventTail, type Progress, startLines, waitingLine } from "./progress";
import { type BatchRequest, orderTickets } from "./request";
import { RUN_DISCLAIMER, type Tracker } from "./tracker";
import { commitWorktree, installManifest, removeWorktree } from "./worktree";

export type RunCode =
  | "manifest-invalid"
  | "model-unavailable"
  | "startup-failed"
  | "supervisor-stalled"
  | "timeout"
  | "failure"
  | "dependency-failed"
  | "success"
  | "batch-halted";

export interface RunOutcome {
  ticket: number;
  slug?: string;
  code: RunCode;
  exitCode?: number;
  detail?: string;
  durationMs?: number;
  /** Launches this ticket needed; more than one means a `startup-failed` was retried (#306). */
  attempts?: number;
  /** Absent when the run never produced a final.md, not zero (the scorecard rule). */
  costUsd?: number;
  tokens?: number;
}

export interface Herdr {
  createWorkspace(input: {
    cwd: string;
    label: string;
  }): Promise<{ workspaceId: string; paneId: string }>;
  runInPane(paneId: string, command: string): Promise<void>;
  /** `herdr workspace get` answers "not found" with exit 0, so absence is the body, not the status. */
  workspaceExists(workspaceId: string): Promise<boolean>;
  closeWorkspace(workspaceId: string): Promise<void>;
  /**
   * What the supervisor pane is doing, plus the question it is waiting on. Absent when the
   * launcher cannot read pane state, so a run never depends on it (#415).
   */
  paneStatus?: (paneId: string) => Promise<{ state: string; question?: string } | undefined>;
}

export interface ExecutorDeps {
  /** The main checkout: worktrees and records live relative to it. */
  repoRoot: string;
  taskDir: string;
  /** The record segment under `taskDir`; defaults to `000-batches`. */
  batchDir?: string;
  policy: BatchPolicy;
  herdr: Herdr;
  /** Writes the run's outcome back to the ticket (comment + label swap on success). */
  tracker: Tracker;
  preflight: (slugs: string[]) => Promise<{ slug: string; ok: boolean }[]>;
  createWorktree: (input: {
    repoRoot: string;
    taskDir: string;
    slug: string;
    base?: string;
  }) => Promise<{ path: string }>;
  installManifest?: typeof installManifest;
  /** Removes a successful ticket's checkout (#246); the branch survives. */
  removeWorktree?: (input: { repoRoot: string; slug: string }) => Promise<void>;
  commitWorktree?: (input: {
    repoRoot: string;
    taskDir: string;
    slug: string;
    base?: string;
  }) => Promise<{ commits: number }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Where `run` says what it is doing (#415). Omitted by `--quiet`, and a no-op otherwise:
   * nothing in the run depends on anybody listening.
   */
  progress?: Progress;
}

const POLL_MS = 5000;
/**
 * A run creates run-details/ as its first act, before any model call (the runtime
 * mkdir's it in start()). If it has not appeared this long after launch, pi exited
 * before the run started — not a slow run — so fail fast instead of polling a dead
 * pane for the full timeout (#285). A tenth of the run's own budget, capped at a minute:
 * the grace must never dominate the timeout it sits inside (#299).
 */
const RUN_START_GRACE_MS = 60_000;
const startGraceMs = (timeoutMs: number): number => Math.min(RUN_START_GRACE_MS, timeoutMs / 10);

interface Plan {
  ticket: number;
  slug: string;
  manifestText: string;
  slugs: string[];
}

/** `<repoRoot>/<taskDir>/<batchDir>` — where a batch's record lives. */
function recordRoot(deps: Pick<ExecutorDeps, "repoRoot" | "taskDir" | "batchDir">): string {
  return join(deps.repoRoot, deps.taskDir, deps.batchDir ?? DEFAULT_BATCH_DIR);
}

function ticketDir(
  deps: Pick<ExecutorDeps, "repoRoot" | "taskDir" | "batchDir">,
  batch: string,
  ticket: number,
): string {
  return join(recordRoot(deps), batch, "tickets", String(ticket));
}

/** Post the run's outcome to the ticket; the record on disk stays the local truth. */
async function writebackOutcome(
  deps: ExecutorDeps,
  batch: string,
  plan: Plan,
  outcome: RunOutcome,
): Promise<void> {
  const marker = `<!-- mypi-batch:${batch}:${plan.ticket}:run -->`;
  const record = join(
    deps.taskDir,
    deps.batchDir ?? DEFAULT_BATCH_DIR,
    batch,
    "tickets",
    String(plan.ticket),
  );
  const text = [
    `outcome: ${outcome.code}`,
    ...(outcome.exitCode === undefined ? [] : [`exit: ${outcome.exitCode}`]),
    ...(outcome.durationMs === undefined ? [] : [`duration: ${outcome.durationMs} ms`]),
    `branch: task/${plan.slug}`,
    `record: ${record}`,
    ...(outcome.detail === undefined ? [] : [`detail: ${outcome.detail}`]),
  ].join("\n");
  await deps.tracker.upsertMarkerComment(plan.ticket, marker, text, RUN_DISCLAIMER);
  if (outcome.code === "success") {
    await deps.tracker.removeLabel(plan.ticket, "ready-for-agent");
    await deps.tracker.addLabel(plan.ticket, "ready-for-human");
  }
}

/**
 * Filesystem timestamps are not nanosecond-precise everywhere: on the CI
 * runner's overlay filesystem a file written in the launch millisecond can
 * report an earlier mtime, which made this guard reject the run's own final.md.
 * Two seconds is far below any real run's poll interval and far above that skew.
 */
const MTIME_SKEW_MS = 2000;

/**
 * `status:` and `exit_code:` are the frontmatter the final writer always emits.
 * A file written before `started` is not this run's verdict: the poll would
 * otherwise report a previous attempt's outcome, or a hand-placed stub's.
 */
function readFinal(
  path: string,
  started: number,
):
  | { status: string; exitCode: number; stamp: string; totalCostUsd?: number; totalTokens?: number }
  | undefined {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(path, "utf8");
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (frontmatter === undefined) return undefined;
  const meta = parseYamlText(frontmatter) as {
    status?: unknown;
    exit_code?: unknown;
    total_cost_usd?: unknown;
    total_tokens?: unknown;
  };
  if (typeof meta.status !== "string" || typeof meta.exit_code !== "number") return undefined;
  if (mtimeMs < started - MTIME_SKEW_MS) return undefined;
  return {
    status: meta.status,
    exitCode: meta.exit_code,
    stamp: `${meta.status}:${meta.exit_code}:${text.length}:${mtimeMs}`,
    ...(typeof meta.total_cost_usd === "number" ? { totalCostUsd: meta.total_cost_usd } : {}),
    ...(typeof meta.total_tokens === "number" ? { totalTokens: meta.total_tokens } : {}),
  };
}

function peerConfigsGone(runDetails: string): boolean {
  try {
    return readdirSync(runDetails).every((name) => !/^\.peer-.*\.json$/.test(name));
  } catch {
    return false;
  }
}

/** Run one ticket's worktree to a verdict, record it, and remove the worktree on success. */
async function runTicket(
  deps: ExecutorDeps,
  plan: Plan,
  base: string | undefined,
  batchId: string,
  timeoutMs: number,
): Promise<RunOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const progress = deps.progress ?? (() => {});
  // Derived from the one knob (#415): a quarter of the ticket budget, floored so a short
  // timeout cannot make an ordinary long turn read as a stall.
  const stallMs = Math.max(60_000, Math.round(timeoutMs / 4));
  const install = deps.installManifest ?? installManifest;
  const remove = deps.removeWorktree ?? removeWorktree;
  const commit = deps.commitWorktree ?? commitWorktree;

  const firstStarted = now();
  const worktree = await deps.createWorktree({
    repoRoot: deps.repoRoot,
    taskDir: deps.taskDir,
    slug: plan.slug,
    base,
  });
  install({
    worktree: worktree.path,
    taskDir: deps.taskDir,
    slug: plan.slug,
    manifestText: plan.manifestText,
  });
  const runDetails = join(worktree.path, deps.taskDir, plan.slug, "run-details");
  // Spec #177: a task dir that already holds a verdict is refused, not re-read —
  // otherwise a leftover report from an earlier attempt answers for this run.
  if (existsSync(join(runDetails, "final.md"))) {
    return {
      ticket: plan.ticket,
      slug: plan.slug,
      code: "failure",
      detail: "this task dir already has a run: run-details/final.md exists",
    };
  }

  // D9: the checkout task dir exists only once a run actually starts, so a session.yaml
  // there never means "queued, never run". The run-details/ copy (#260) lands beside it.
  const checkoutDir = join(deps.repoRoot, deps.taskDir, plan.slug);
  mkdirSync(checkoutDir, { recursive: true });
  writeFileSync(join(checkoutDir, "session.yaml"), plan.manifestText);

  let outcome: RunOutcome | undefined;
  let attempts = 0;
  // D12: a start failure gets one retry. A launch that never reached the
  // runtime is the fault most likely to be transient, and the checkout is still there to
  // reuse (#306). Each attempt gets its own start time, so the staleness guard cannot read
  // the previous attempt's final.md and `run.timeout_minutes` still bounds one run.
  while (outcome === undefined) {
    attempts += 1;
    const started = now();
    const { workspaceId, paneId } = await deps.herdr.createWorkspace({
      cwd: worktree.path,
      label: `mypi-${plan.slug}`,
    });
    // Before the wait, not after it: where the run is, and what to read to watch it (#415).
    for (const line of startLines({
      batch: batchId,
      ticket: plan.ticket,
      slug: plan.slug,
      worktree: worktree.path,
      base: base ?? "main",
      paneId,
      deadline: started + timeoutMs,
    })) {
      progress(line);
    }
    try {
      // The run is unattended by construction: a peer has no UI to answer a prompt (#415).
      await deps.herdr.runInPane(paneId, `MYPY_UNATTENDED=1 pi "/mypi-multi-agent ${plan.slug}"`);
      const launchDeadline = now() + startGraceMs(timeoutMs);

      let previous: string | undefined;
      const tail = new EventTail();
      // Undefined until the run says anything: a run that never emits a single event is a
      // timeout, not a stall — there is no progress baseline to be late from.
      let lastProgress: number | undefined;
      let asked: string | undefined;
      let final:
        | { status: string; exitCode: number; totalCostUsd?: number; totalTokens?: number }
        | undefined;
      for (;;) {
        if (!(await deps.herdr.workspaceExists(workspaceId))) {
          outcome = {
            ticket: plan.ticket,
            slug: plan.slug,
            code: "startup-failed",
            detail: "workspace disappeared",
          };
          break;
        }
        if (!existsSync(runDetails) && now() > launchDeadline) {
          outcome = {
            ticket: plan.ticket,
            slug: plan.slug,
            code: "startup-failed",
            detail: "run never created run-details/",
          };
          break;
        }
        const read = readFinal(join(runDetails, "final.md"), started);
        // Two identical reads, then the transient peer configs gone: "decided" is not "finished".
        if (read !== undefined && read.stamp === previous && peerConfigsGone(runDetails)) {
          final = read;
          break;
        }
        // What the run has said since the last poll; the question it is stuck on, if any.
        const events = tail.read(join(runDetails, "conversation.jsonl"));
        for (const line of events) progress(line);
        const state = await deps.herdr.paneStatus?.(paneId);
        if (state?.question !== undefined && state.question !== asked) {
          asked = state.question;
          progress(waitingLine(paneId, state.question));
        }
        if (events.length > 0 || (read !== undefined && read.stamp !== previous)) {
          lastProgress = now();
        }
        previous = read?.stamp;
        const quietFor = now() - (lastProgress ?? started);
        if (quietFor > stallMs && (lastProgress !== undefined || asked !== undefined)) {
          outcome = {
            ticket: plan.ticket,
            slug: plan.slug,
            code: "supervisor-stalled",
            detail:
              asked === undefined
                ? `no run event for ${stallMs} ms`
                : `waiting for input in ${paneId}: ${asked}`,
          };
          break;
        }
        if (now() - started > timeoutMs) {
          outcome = {
            ticket: plan.ticket,
            slug: plan.slug,
            code: "timeout",
            detail: `${timeoutMs} ms`,
          };
          break;
        }
        await sleep(POLL_MS);
      }

      if (outcome === undefined) {
        const cost =
          final === undefined
            ? {}
            : {
                ...(final.totalCostUsd === undefined ? {} : { costUsd: final.totalCostUsd }),
                ...(final.totalTokens === undefined ? {} : { tokens: final.totalTokens }),
              };
        outcome =
          final !== undefined && final.exitCode === 0
            ? { ticket: plan.ticket, slug: plan.slug, code: "success", exitCode: 0, ...cost }
            : {
                ticket: plan.ticket,
                slug: plan.slug,
                code: "failure",
                ...(final === undefined ? {} : { exitCode: final.exitCode }),
                ...cost,
                detail: final === undefined ? "no final.md" : `status ${final.status}`,
              };
      }
    } catch (err) {
      outcome = {
        ticket: plan.ticket,
        slug: plan.slug,
        code: "startup-failed",
        detail: (err as Error).message,
      };
    } finally {
      await deps.herdr.closeWorkspace(workspaceId).catch(() => {});
    }
    if (outcome.code !== "startup-failed" || attempts === 2) break;
    outcome = undefined;
  }

  outcome.attempts = attempts;
  outcome.durationMs = now() - firstStarted;
  // The branch is the deliverable: commit whatever the implementers left in the
  // worktree before it is removed, or a "success" would discard it (#289). A branch
  // with no commits is not a success — that is the #289 case a run reported through
  // (#299), so the remap spreads the outcome rather than rebuilding it and dropping
  // the cost and duration the record needs most on a failure.
  if (outcome.code === "success") {
    try {
      const { commits } = await commit({
        repoRoot: deps.repoRoot,
        taskDir: deps.taskDir,
        slug: plan.slug,
        base,
      });
      if (commits === 0) {
        outcome = {
          ...outcome,
          code: "failure",
          detail: `no commits on task/${plan.slug}: the run left the branch empty`,
        };
      }
    } catch (err) {
      outcome = {
        ...outcome,
        code: "failure",
        detail: `commit failed: ${(err as Error).message}`,
      };
    }
  }
  const record = ticketDir(deps, batchId, plan.ticket);
  mkdirSync(record, { recursive: true });
  // One copy of the evidence: the whole run-details/ moves to the checkout task dir,
  // so the record holds only decisions and the run's artifacts survive the worktree.
  if (existsSync(runDetails)) {
    mkdirSync(join(deps.repoRoot, deps.taskDir, plan.slug), { recursive: true });
    cpSync(runDetails, join(deps.repoRoot, deps.taskDir, plan.slug, "run-details"), {
      recursive: true,
      force: true,
    });
  }
  writeFileSync(join(record, "run.json"), `${JSON.stringify(outcome, null, 2)}\n`);
  // The ticket is where the work is tracked: record the run's outcome there too.
  try {
    await writebackOutcome(deps, batchId, plan, outcome);
  } catch (err) {
    console.error(`writeback for #${plan.ticket} failed: ${(err as Error).message}`);
  }
  // A successful branch is the deliverable and its artifacts are already copied to the
  // checkout task dir, so the worktree has no further use. A non-success keeps the
  // worktree: someone has to look at it (#246).
  if (outcome.code === "success") {
    await remove({ repoRoot: deps.repoRoot, slug: plan.slug });
  }
  return outcome;
}

export async function runBatch(
  deps: ExecutorDeps,
  request: BatchRequest,
  options: { timeoutMinutes?: number } = {},
): Promise<RunOutcome[]> {
  const timeoutMs = (options.timeoutMinutes ?? deps.policy.run.timeoutMinutes) * 60_000;

  // Refuse before spending: nothing is created for a batch that cannot launch.
  const plans: Plan[] = [];
  for (const ticket of request.tickets) {
    const record = ticketDir(deps, request.id, ticket);
    const slug = `b-${request.id}-t${ticket}`;
    if (existsSync(join(record, "run.json"))) {
      return [
        { ticket, slug, code: "failure", detail: "this batch already has run records" },
        ...haltedPlans(request, ticket),
      ];
    }
    try {
      const manifestText = readFileSync(join(record, "manifest.yaml"), "utf8");
      parseSessionConfig(parseYamlText(manifestText), () => false);
      plans.push({ ticket, slug, manifestText, slugs: manifestSlugs(manifestText) });
    } catch (err) {
      const outcomes = [
        { ticket, slug, code: "manifest-invalid" as const, detail: (err as Error).message },
        ...haltedPlans(request, ticket),
      ];
      writeSummary(deps, request, outcomes);
      return outcomes;
    }
  }

  const unresolved = new Map<number, string[]>();
  for (const plan of plans) {
    const bad = (await deps.preflight(plan.slugs)).filter((r) => !r.ok).map((r) => r.slug);
    if (bad.length > 0) unresolved.set(plan.ticket, bad);
  }

  const dependsOn = request.dependsOn ?? {};
  const planByTicket = new Map(plans.map((plan) => [plan.ticket, plan]));
  const planFor = (ticket: number): Plan => {
    const plan = planByTicket.get(ticket);
    if (plan === undefined) throw new Error(`no manifest for ticket #${ticket}`);
    return plan;
  };
  const ordered = orderTickets(request.tickets, dependsOn).map(planFor);

  const outcomes: RunOutcome[] = [];
  const failed = new Set<number>();
  for (const plan of ordered) {
    const dep = dependsOn[plan.ticket];
    if (dep !== undefined && failed.has(dep)) {
      outcomes.push({
        ticket: plan.ticket,
        slug: plan.slug,
        code: "dependency-failed",
        detail: `dependency #${dep} did not succeed`,
      });
      failed.add(plan.ticket);
      continue;
    }
    const base = dep === undefined ? undefined : `task/${planFor(dep).slug}`;

    const unavailable = unresolved.get(plan.ticket);
    if (unavailable !== undefined) {
      outcomes.push({
        ticket: plan.ticket,
        slug: plan.slug,
        code: "model-unavailable",
        detail: unavailable.join(", "),
      });
      failed.add(plan.ticket);
      continue;
    }

    const outcome = await runTicket(deps, plan, base, request.id, timeoutMs);
    outcomes.push(outcome);
    if (outcome.code !== "success") failed.add(plan.ticket);
  }
  writeSummary(deps, request, outcomes);
  return outcomes;
}

/** Batch-level record: what the run decided, in one file a human can read. */
function writeSummary(
  deps: Pick<ExecutorDeps, "repoRoot" | "taskDir" | "batchDir">,
  request: BatchRequest,
  outcomes: RunOutcome[],
): void {
  const dir = join(recordRoot(deps), request.id);
  mkdirSync(dir, { recursive: true });
  const totalCostUsd = outcomes.reduce((sum, o) => sum + (o.costUsd ?? 0), 0);
  writeFileSync(
    join(dir, "summary.json"),
    `${JSON.stringify({ id: request.id, totalCostUsd, outcomes }, null, 2)}\n`,
  );

  const succeeded = outcomes.filter((o) => o.code === "success").length;
  const blocked = outcomes.filter((o) => o.code === "dependency-failed").length;
  const verdict =
    succeeded === outcomes.length
      ? `${succeeded} of ${outcomes.length} succeeded.`
      : `${succeeded} of ${outcomes.length} succeeded; ${outcomes.length - succeeded} did not${blocked > 0 ? ` (${blocked} dependency-failed)` : ""}.`;
  const rows = outcomes.map((o) => {
    const cost = o.costUsd === undefined ? "" : `$${o.costUsd}`;
    const extra = [o.exitCode === undefined ? "" : `exit ${o.exitCode}`, o.detail ?? ""]
      .filter(Boolean)
      .join(" ");
    return `| ${o.ticket} | ${o.slug ?? ""} | ${o.code} | ${cost} | ${extra} |`;
  });
  writeFileSync(
    join(dir, "summary.md"),
    [
      `# Batch ${request.id}`,
      "",
      verdict,
      `cost: $${totalCostUsd}`,
      "",
      "| ticket | slug | outcome | cost | detail |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );
}

/** Everything after the refused ticket, by the request order the caller asked for. */
function haltedPlans(request: BatchRequest, from: number): RunOutcome[] {
  return request.tickets
    .slice(request.tickets.indexOf(from) + 1)
    .map((ticket) => ({ ticket, code: "batch-halted" as const }));
}
