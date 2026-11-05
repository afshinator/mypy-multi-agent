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
import type { BatchRequest } from "./request";
import { RUN_DISCLAIMER, type Tracker } from "./tracker";
import { commitWorktree, installManifest, removeWorktree } from "./worktree";

export type RunCode =
  | "manifest-invalid"
  | "model-unavailable"
  | "startup-failed"
  | "timeout"
  | "failure"
  | "success"
  | "batch-halted";

export interface RunOutcome {
  ticket: number;
  slug?: string;
  code: RunCode;
  exitCode?: number;
  detail?: string;
  durationMs?: number;
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
  }) => Promise<{ path: string }>;
  installManifest?: typeof installManifest;
  /** Removes a successful ticket's checkout (#246); the branch survives. */
  removeWorktree?: (input: { repoRoot: string; slug: string }) => Promise<void>;
  commitWorktree?: (input: {
    repoRoot: string;
    taskDir: string;
    slug: string;
  }) => Promise<{ commits: number }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

function halted(plans: readonly Plan[], from: number): RunOutcome[] {
  return plans.slice(from).map((plan) => ({ ticket: plan.ticket, code: "batch-halted" as const }));
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

export async function runBatch(
  deps: ExecutorDeps,
  request: BatchRequest,
  options: { timeoutMinutes?: number } = {},
): Promise<RunOutcome[]> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const install = deps.installManifest ?? installManifest;
  const remove = deps.removeWorktree ?? removeWorktree;
  const commit = deps.commitWorktree ?? commitWorktree;
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

  const outcomes: RunOutcome[] = [];
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i] as Plan;
    const unavailable = unresolved.get(plan.ticket);
    if (unavailable !== undefined) {
      outcomes.push({
        ticket: plan.ticket,
        slug: plan.slug,
        code: "model-unavailable",
        detail: unavailable.join(", "),
      });
      outcomes.push(...halted(plans, i + 1));
      writeSummary(deps, request, outcomes);
      return outcomes;
    }

    const started = now();
    const worktree = await deps.createWorktree({
      repoRoot: deps.repoRoot,
      taskDir: deps.taskDir,
      slug: plan.slug,
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
      const outcomes = [
        {
          ticket: plan.ticket,
          slug: plan.slug,
          code: "failure" as const,
          detail: "this task dir already has a run: run-details/final.md exists",
        },
        ...halted(plans, i + 1),
      ];
      writeSummary(deps, request, outcomes);
      return outcomes;
    }

    // D9: the checkout task dir exists only once a run actually starts, so a session.yaml
    // there never means "queued, never run". The run-details/ copy (#260) lands beside it.
    const checkoutDir = join(deps.repoRoot, deps.taskDir, plan.slug);
    mkdirSync(checkoutDir, { recursive: true });
    writeFileSync(join(checkoutDir, "session.yaml"), plan.manifestText);

    const { workspaceId, paneId } = await deps.herdr.createWorkspace({
      cwd: worktree.path,
      label: `mypi-${plan.slug}`,
    });

    let outcome: RunOutcome | undefined;
    try {
      await deps.herdr.runInPane(paneId, `pi "/mypi-multi-agent ${plan.slug}"`);
      const launchDeadline = now() + startGraceMs(timeoutMs);

      let previous: string | undefined;
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
        previous = read?.stamp;
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

    outcome.durationMs = now() - started;
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
    const record = ticketDir(deps, request.id, plan.ticket);
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
      await writebackOutcome(deps, request.id, plan, outcome);
    } catch (err) {
      console.error(`writeback for #${plan.ticket} failed: ${(err as Error).message}`);
    }
    outcomes.push(outcome);

    // A successful branch is the deliverable and its artifacts are already copied to the
    // checkout task dir, so the worktree has no further use. A non-success is the halting
    // ticket: someone has to look at that worktree, so it stays (#246).
    if (outcome.code === "success") {
      await remove({ repoRoot: deps.repoRoot, slug: plan.slug });
    }

    if (outcome.code !== "success") {
      outcomes.push(...halted(plans, i + 1));
      writeSummary(deps, request, outcomes);
      return outcomes;
    }
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
  const halted = outcomes.filter((o) => o.code === "batch-halted").length;
  const verdict =
    halted === 0 && succeeded === outcomes.length
      ? `${succeeded} of ${outcomes.length} succeeded.`
      : `${succeeded} of ${outcomes.length} succeeded; the batch halted at #${outcomes.find((o) => o.code !== "success" && o.code !== "batch-halted")?.ticket ?? "?"}.`;
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
