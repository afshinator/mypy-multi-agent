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
  copyFileSync,
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
import type { BatchPolicy } from "./policy";
import { manifestSlugs } from "./prepare";
import type { BatchRequest } from "./request";
import { installManifest } from "./worktree";

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
  policy: BatchPolicy;
  herdr: Herdr;
  preflight: (slugs: string[]) => Promise<{ slug: string; ok: boolean }[]>;
  createWorktree: (input: {
    repoRoot: string;
    taskDir: string;
    slug: string;
  }) => Promise<{ path: string }>;
  installManifest?: typeof installManifest;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const POLL_MS = 5000;

interface Plan {
  ticket: number;
  slug: string;
  manifestText: string;
  slugs: string[];
}

function ticketDir(repoRoot: string, batch: string, ticket: number): string {
  return join(repoRoot, "batches", batch, "tickets", String(ticket));
}

function halted(plans: readonly Plan[], from: number): RunOutcome[] {
  return plans.slice(from).map((plan) => ({ ticket: plan.ticket, code: "batch-halted" as const }));
}

/** `status:` and `exit_code:` are the frontmatter the final writer always emits. */
function readFinal(path: string): { status: string; exitCode: number; stamp: string } | undefined {
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
  const meta = parseYamlText(frontmatter) as { status?: unknown; exit_code?: unknown };
  if (typeof meta.status !== "string" || typeof meta.exit_code !== "number") return undefined;
  return {
    status: meta.status,
    exitCode: meta.exit_code,
    stamp: `${meta.status}:${meta.exit_code}:${text.length}:${mtimeMs}`,
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
  const timeoutMs = (options.timeoutMinutes ?? deps.policy.run.timeoutMinutes) * 60_000;

  // Refuse before spending: nothing is created for a batch that cannot launch.
  const plans: Plan[] = [];
  for (const ticket of request.tickets) {
    const record = ticketDir(deps.repoRoot, request.id, ticket);
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
      return [
        { ticket, slug, code: "manifest-invalid", detail: (err as Error).message },
        ...haltedPlans(request, ticket),
      ];
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

    const { workspaceId, paneId } = await deps.herdr.createWorkspace({
      cwd: worktree.path,
      label: `mypi-${plan.slug}`,
    });

    let outcome: RunOutcome | undefined;
    try {
      await deps.herdr.runInPane(paneId, `pi "/mypi-multi-agent ${plan.slug}"`);

      let previous: string | undefined;
      let final: { status: string; exitCode: number } | undefined;
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
        const read = readFinal(join(runDetails, "final.md"));
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
        outcome =
          final !== undefined && final.exitCode === 0
            ? { ticket: plan.ticket, slug: plan.slug, code: "success", exitCode: 0 }
            : {
                ticket: plan.ticket,
                slug: plan.slug,
                code: "failure",
                ...(final === undefined ? {} : { exitCode: final.exitCode }),
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
    const record = ticketDir(deps.repoRoot, request.id, plan.ticket);
    mkdirSync(record, { recursive: true });
    for (const artifact of ["final.md", "findings.md", "scorecard.json"]) {
      const source = join(runDetails, artifact);
      if (existsSync(source)) copyFileSync(source, join(record, artifact));
    }
    writeFileSync(join(record, "run.json"), `${JSON.stringify(outcome, null, 2)}\n`);
    outcomes.push(outcome);

    if (outcome.code !== "success") {
      outcomes.push(...halted(plans, i + 1));
      return outcomes;
    }
  }
  return outcomes;
}

/** Everything after the refused ticket, by the request order the caller asked for. */
function haltedPlans(request: BatchRequest, from: number): RunOutcome[] {
  return request.tickets
    .slice(request.tickets.indexOf(from) + 1)
    .map((ticket) => ({ ticket, code: "batch-halted" as const }));
}
