#!/usr/bin/env bun
/**
 * `mypi-batch` entry point. One dispatcher, one verb so far: `new` writes
 * `000-batches/<id>/request.yaml` once. `prepare`, `retemplate` and `run` are not
 * implemented yet and are refused by name, so nobody reads a silent no-op as a
 * finished batch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { runAgent } from "./agent";
import { makeClone, removeClone } from "./clone";
import { type RunOutcome, runBatch } from "./executor";
import { createHerdr } from "./herdr-cli";
import { batchDirOf, DEFAULT_TASK_DIR, recordRoot, taskDirOf } from "./paths";
import { type BatchPolicy, parsePolicy } from "./policy";
import { resolveModels } from "./preflight";
import {
  BLOCKERS_UNKNOWN_LINE,
  check,
  type PrepareDeps,
  prepare,
  REFUSAL_REMEDY,
  retriedLabel,
  type TicketOutcome,
} from "./prepare";
import { type BatchRequest, batchTaskSlug, parseRequest, REQUEST_ID, requestYaml } from "./request";
import { renderRunLogFiles } from "./run-log";
import { createGithubTracker } from "./tracker";
import { createWorktree } from "./worktree";

export interface CliIO {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** `new` is the one verb that asks; absent (a pipe) means refuse and name `--yes`, never wait. */
  confirm?: (question: string) => Promise<boolean>;
}

const USAGE = [
  "usage: mypi-batch <command>",
  "",
  "  new <id> <ticket...> [--yes]",
  "                           run the free gates, then write; --yes writes despite blockers",
  "  check <id> [--kind <kind>]",
  "                           the gates that need no clone or model call; writes nothing",
  "  prepare <id> [--dry-run] [--kind <kind>]",
  "                           verify each ticket, then comment and label it",
  "  run <id> [--quiet]     execute the accepted manifests serially",
  "  launch <id> <ticket>     write a halted ticket's manifest into its task dir",
  "  status <id> [--wait]     what each ticket finished as; --wait blocks until the batch ends",
  "  log <slug>               print one run's full timeline from its run-details",
  "  go <id>                  prepare then run, streaming both phases",
  "",
  "  --dry-run still runs both agents (it is not free); it only skips the writes.",
  "",
  "  retemplate is not implemented yet.",
].join("\n");

function requestPath(cwd: string, id: string): string {
  return join(recordRoot(cwd), id, "request.yaml");
}

/** The I/O `createBatch` needs: `new` is the one verb that asks. */
export interface BatchCreateIO {
  out: (line: string) => void;
  err: (line: string) => void;
  confirm?: (question: string) => Promise<boolean>;
}

/**
 * `new` is the one place a batch is created, so it is the one place the free gates run before
 * anything is written. A blocker is information, never a refusal: it is printed and, unless `--yes`,
 * the operator confirms. When the check cannot run at all (no policy, no `gh`), the same `--yes` is
 * the only way past it — nothing is written without the word.
 */
export async function createBatch(
  deps: PrepareDeps,
  policy: BatchPolicy | undefined,
  request: BatchRequest,
  io: BatchCreateIO,
  yes: boolean,
): Promise<number> {
  const path = requestPath(deps.cwd, request.id);
  const full = join(deps.cwd, path);
  if (existsSync(full)) {
    io.err(`${path} already exists — a batch request is written once`);
    return 1;
  }

  // Check before write: the free gates, printed with the same formatter `check` uses.
  let outcomes: TicketOutcome[] | undefined;
  let unavailable: string | undefined;
  if (policy === undefined) {
    unavailable = "mypi-batch.yaml is missing or unreadable";
  } else {
    outcomes = await check(deps, policy, request);
    const infra = outcomes.find((outcome) => outcome.code === "infra-error");
    if (infra !== undefined) unavailable = infra.detail ?? "the tracker could not be reached";
  }
  if (outcomes !== undefined) printOutcomes(io.out, outcomes);

  if (unavailable !== undefined) {
    if (!yes) {
      io.err(`cannot check (${unavailable}) — pass --yes to write the request anyway`);
      return 1;
    }
    io.out(`could not check: ${unavailable}`);
  }

  const blocked = (outcomes ?? []).some((outcome) => outcome.blockedBy !== undefined);
  const unknown = (outcomes ?? []).some((outcome) => outcome.blockersUnknown === true);
  if ((blocked || unknown) && !yes) {
    const reason = blocked
      ? "some tickets are blocked by open issues"
      : "blocker status is unknown for some tickets";
    const answer =
      io.confirm === undefined ? false : await io.confirm(`${reason} — write the batch anyway?`);
    if (!answer) {
      io.err(`not written: ${reason} — pass --yes to write anyway`);
      return 1;
    }
  }

  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, requestYaml(request));
  io.out(`wrote ${path}`);
  return 0;
}

async function newBatch(argv: string[], io: CliIO): Promise<number> {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const [id, ...tickets] = positional;
  const yes = argv.includes("--yes");
  const unknown = argv.filter((arg) => arg.startsWith("--") && arg !== "--yes");
  if (unknown.length > 0) {
    io.err(`unknown flag ${unknown[0]}`);
    return 1;
  }
  if (id === undefined || tickets.length === 0) {
    io.err(`usage: mypi-batch new <id> <ticket...> [--yes]`);
    return 1;
  }
  const request: BatchRequest = { id, tickets: tickets.map(Number) };
  try {
    // Prove the bytes before any tracker call: a bad id or ticket is refused here, not by `gh`.
    requestYaml(request);
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }

  let policy: BatchPolicy | undefined;
  try {
    policy = parsePolicy(readFileSync(join(io.cwd, "mypi-batch.yaml"), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      policy = undefined; // absent -> the --yes offline escape
    } else {
      io.err((err as Error).message);
      return 1;
    }
  }

  return createBatch({ ...liveDeps(io.cwd), cwd: io.cwd }, policy, request, io, yes);
}

/**
 * `--quiet` is the scripting surface: one line per ticket, no progress (#415). Anything
 * else prints what the run is doing, because a batch that says nothing for ten minutes is
 * indistinguishable from one that is stuck.
 */
export function progressFor(
  quiet: boolean,
  out: (line: string) => void,
): ((line: string) => void) | undefined {
  return quiet ? undefined : out;
}

/** The I/O boundary: everything `prepare` treats as a seam gets its real implementation here. */
function liveDeps(repoRoot: string): PrepareDeps {
  return {
    cwd: process.cwd(),
    taskDir: taskDirOf(repoRoot),
    batchDir: batchDirOf(repoRoot),
    tracker: createGithubTracker(),
    agent: runAgent,
    preflight: resolveModels,
    clone: {
      async make(omit?: string[]) {
        return makeClone(repoRoot, omit);
      },
      async remove(dir) {
        removeClone(dir);
      },
    },
    revision: (dir) =>
      execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

/**
 * One prepare result: `<ticket>\t<verdict>\t<detail>\t<cost>[\tretried: <sites>]`, cost last so it
 * is optional, and the retry trail trailing it because a prepare has at most a few (#375).
 */
export function outcomeLine(o: TicketOutcome): string {
  const verdict = o.ok ? "ok" : (o.code ?? "refused");
  const detail = o.ok
    ? `${o.kind}${o.slug === undefined ? "" : ` ${o.slug}`} ${o.criteria?.length ?? 0} criteria`
    : (o.detail ?? "");
  // A ticket that never reached an agent has no cost, so the column stays empty, not $0.
  const cost = o.costUsd === undefined ? "" : `$${o.costUsd}`;
  const label = retriedLabel(o.retried ?? []);
  const retried = label === "" ? "" : `\t${label}`;
  return `${o.ticket}\t${verdict}\t${detail}\t${cost}${retried}`.trimEnd();
}

async function runPrepare(argv: string[], io: CliIO): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("--"));
  const dryRun = argv.includes("--dry-run");
  // --break-lock is the operator's explicit word: only they may evict a live or unreadable lock.
  const breakLock = argv.includes("--break-lock");
  // --kind pins the template: the triage still writes the criteria, but it no longer
  // classifies, so a ladder rung can be chosen instead of guessed.
  const kindAt = argv.indexOf("--kind");
  const kind = kindAt === -1 ? undefined : argv[kindAt + 1];
  if (id === undefined || (kindAt !== -1 && (kind === undefined || kind.startsWith("--")))) {
    io.err("usage: mypi-batch prepare <id> [--dry-run] [--kind <kind>] [--break-lock]");
    return 1;
  }

  const policyPath = join(io.cwd, "mypi-batch.yaml");
  const requestFile = join(io.cwd, recordRoot(io.cwd), id, "request.yaml");
  let policy: ReturnType<typeof parsePolicy>;
  let request: ReturnType<typeof parseRequest>;
  try {
    policy = parsePolicy(readFileSync(policyPath, "utf8"));
    request = parseRequest(readFileSync(requestFile, "utf8"));
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }

  let outcomes: TicketOutcome[];
  try {
    outcomes = await prepare({ ...liveDeps(io.cwd), cwd: io.cwd, out: io.out }, policy, request, {
      dryRun,
      ...(kind === undefined ? {} : { kind }),
      ...(breakLock ? { breakLock } : {}),
    });
  } catch (err) {
    // A usage fault the parser cannot see (a pin beside a mapped request) is a message, not a stack.
    io.err((err as Error).message);
    return 1;
  }
  for (const outcome of outcomes) io.out(outcomeLine(outcome));
  return outcomes.every((o) => o.ok) ? 0 : 1;
}

/** The `check` output: one line per ticket, the blocker advisory under an `ok`, and a remedy per refusal. */
function printOutcomes(out: (line: string) => void, outcomes: TicketOutcome[]): void {
  for (const outcome of outcomes) {
    if (outcome.ok) {
      out(`${outcome.ticket}\tok\tnothing here needs a clone or a model call`);
      if (outcome.blockersUnknown) out(`\t${BLOCKERS_UNKNOWN_LINE}`);
      if (outcome.blockedBy !== undefined) out(`\t${outcome.blockedBy}`);
      continue;
    }
    out(`${outcome.ticket}\t${outcome.code ?? "refused"}\t${outcome.detail ?? ""}`.trimEnd());
    const code = outcome.code;
    if (code !== undefined) out(`\twhat to change: ${REFUSAL_REMEDY[code]}`);
  }
}

/**
 * The answer a prepare would give before it clones or pays: the free gates only, nothing written and
 * nothing posted. A refusal prints what to change, because knowing the code alone leaves the reader
 * where the refusal found them (#502).
 */
async function runCheck(argv: string[], io: CliIO): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("--"));
  const kindAt = argv.indexOf("--kind");
  const kind = kindAt === -1 ? undefined : argv[kindAt + 1];
  if (id === undefined || (kindAt !== -1 && (kind === undefined || kind.startsWith("--")))) {
    io.err("usage: mypi-batch check <id> [--kind <kind>]");
    return 1;
  }

  const policyPath = join(io.cwd, "mypi-batch.yaml");
  const requestFile = join(io.cwd, recordRoot(io.cwd), id, "request.yaml");
  let policy: ReturnType<typeof parsePolicy>;
  let request: ReturnType<typeof parseRequest>;
  try {
    policy = parsePolicy(readFileSync(policyPath, "utf8"));
    request = parseRequest(readFileSync(requestFile, "utf8"));
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }

  let outcomes: TicketOutcome[];
  try {
    outcomes = await check({ ...liveDeps(io.cwd), cwd: io.cwd }, policy, request, {
      ...(kind === undefined ? {} : { kind }),
    });
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
  printOutcomes(io.out, outcomes);
  return outcomes.every((o) => o.ok) ? 0 : 1;
}

async function runRun(argv: string[], io: CliIO): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("--"));
  // --quiet is the scripting surface: one line per ticket, as before #415.
  const quiet = argv.includes("--quiet");
  // --pr opens a PR per ticket instead of folding into a run branch; --merge merges the PR(s) (#584).
  const pr = argv.includes("--pr");
  const merge = argv.includes("--merge");
  if (id === undefined) {
    io.err("usage: mypi-batch run <id> [--quiet] [--pr] [--merge]");
    return 1;
  }

  let policy: ReturnType<typeof parsePolicy>;
  let request: ReturnType<typeof parseRequest>;
  let taskDir: string;
  try {
    policy = parsePolicy(readFileSync(join(io.cwd, "mypi-batch.yaml"), "utf8"));
    request = parseRequest(
      readFileSync(join(io.cwd, recordRoot(io.cwd), id, "request.yaml"), "utf8"),
    );
    const configured = taskDirOf(io.cwd);
    if (configured === undefined) throw new Error("mypi-multi-agent.yaml: no taskDirs");
    taskDir = configured;
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }

  const outcomes = await runBatch(
    {
      repoRoot: io.cwd,
      taskDir,
      batchDir: batchDirOf(io.cwd),
      policy,
      herdr: createHerdr(),
      tracker: createGithubTracker(),
      preflight: resolveModels,
      createWorktree,
      progress: progressFor(quiet, io.out),
    },
    request,
    { land: pr ? "pr" : "fold", merge },
  );

  // The fold-in final PR failure is batch-level, recorded in the summary, not a ticket outcome.
  let landError: string | undefined;
  const summaryPath = join(io.cwd, recordRoot(io.cwd), id, "summary.json");
  if (existsSync(summaryPath)) {
    landError = (JSON.parse(readFileSync(summaryPath, "utf8")) as { landError?: string }).landError;
  }

  for (const o of outcomes) {
    const detail = [o.exitCode === undefined ? "" : `exit ${o.exitCode}`, o.detail ?? ""]
      .filter(Boolean)
      .join(" ");
    io.out(`${o.ticket}\t${o.code}\t${detail}`.trimEnd());
  }
  if (landError !== undefined) io.err(landError);
  return outcomes.every((o) => o.code === "success") && landError === undefined ? 0 : 1;
}

const STATUS_POLL_MS = 10_000;

/** `<ticket>\t<code>\t<detail>`, or `pending` while that ticket has no record. */
function stateLine(ticket: number, outcome: RunOutcome | undefined): string {
  if (outcome === undefined) return `${ticket}\tpending`;
  return [ticket, outcome.code, outcome.detail ?? ""].join("\t").trimEnd();
}

/**
 * `status <id> [--wait] [--interval <ms>]`: what each ticket finished as, read from the
 * records rather than from the run's log (#453). `--wait` blocks until `summary.json` — the
 * marker `runBatch` writes on every path — exists, printing a line per state change.
 */
async function runStatus(argv: string[], io: CliIO): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("--"));
  const wait = argv.includes("--wait");
  const intervalAt = argv.indexOf("--interval");
  const interval = intervalAt === -1 ? STATUS_POLL_MS : Number(argv[intervalAt + 1]);
  if (id === undefined || !Number.isFinite(interval) || interval <= 0) {
    io.err("usage: mypi-batch status <id> [--wait] [--interval <ms>]");
    return 1;
  }

  let request: ReturnType<typeof parseRequest>;
  try {
    request = parseRequest(
      readFileSync(join(io.cwd, recordRoot(io.cwd), id, "request.yaml"), "utf8"),
    );
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }

  const root = join(io.cwd, recordRoot(io.cwd), id);
  const marker = join(root, "summary.json");
  const shown = new Map<number, string>();
  const report = () => {
    // The summary carries a halted ticket's outcome, which never wrote a per-ticket record.
    const ended = existsSync(marker)
      ? (JSON.parse(readFileSync(marker, "utf8")) as { outcomes: RunOutcome[] }).outcomes
      : undefined;
    for (const ticket of request.tickets) {
      const record = join(root, "tickets", String(ticket), "run.json");
      const own = existsSync(record)
        ? (JSON.parse(readFileSync(record, "utf8")) as RunOutcome)
        : undefined;
      const line = stateLine(ticket, own ?? ended?.find((o) => o.ticket === ticket));
      if (shown.get(ticket) !== line) {
        io.out(line);
        shown.set(ticket, line);
      }
    }
  };

  report();
  while (wait && !existsSync(marker)) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    report();
  }
  return 0;
}

/** Recovery path for a halted ticket: materialise its record manifest into the task dir. */
async function runLaunch(argv: string[], io: CliIO): Promise<number> {
  const [id, ticketArg, ...extra] = argv;
  const ticket = Number(ticketArg);
  if (
    id === undefined ||
    ticketArg === undefined ||
    extra.length > 0 ||
    !Number.isInteger(ticket) ||
    ticket < 1
  ) {
    io.err("usage: mypi-batch launch <id> <ticket>");
    return 1;
  }
  try {
    if (!REQUEST_ID.test(id)) throw new Error(`id must match ${REQUEST_ID.source}, got "${id}"`);
    const slug = batchTaskSlug(id, ticket);
    const manifest = join(recordRoot(io.cwd), id, "tickets", String(ticket), "manifest.yaml");
    const fullManifest = join(io.cwd, manifest);
    if (!existsSync(fullManifest)) {
      throw new Error(`${manifest} does not exist — prepare the batch first`);
    }
    const taskDir = taskDirOf(io.cwd) ?? DEFAULT_TASK_DIR;
    const destDir = join(io.cwd, taskDir, slug);
    if (existsSync(join(destDir, "run-details", "final.md"))) {
      throw new Error(
        `${join(taskDir, slug, "run-details", "final.md")} exists — this ticket already ran`,
      );
    }
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "session.yaml"), readFileSync(fullManifest, "utf8"));
    io.out(`wrote ${join(taskDir, slug, "session.yaml")}`);
    return 0;
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
}

/** prepare then run, so a caller watches both phases in one command. */
async function runGo(argv: string[], io: CliIO): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("--"));
  if (id === undefined) {
    io.err("usage: mypi-batch go <id> [--pr] [--merge]");
    return 1;
  }
  await runPrepare([id], io);
  // Forward the run flags: go is prepare then run, and prepare does not read --pr/--merge (#584).
  return runRun(argv, io);
}

/** One run's full timeline, after the fact, from its run-details. */
async function runLog(argv: string[], io: CliIO): Promise<number> {
  const slug = argv.find((arg) => !arg.startsWith("--"));
  if (slug === undefined) {
    io.err("usage: mypi-batch log <slug>");
    return 1;
  }
  const taskDir = taskDirOf(io.cwd) ?? DEFAULT_TASK_DIR;
  const dir = join(io.cwd, taskDir, slug, "run-details");
  if (!existsSync(dir)) {
    io.err(`${dir} does not exist`);
    return 1;
  }
  const { lines, summary } = renderRunLogFiles(dir);
  for (const line of lines) io.out(line);
  io.out("");
  for (const line of summary) io.out(line);
  return 0;
}

function confirmOnStdin(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    io.out(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "new") return newBatch(rest, io);
  if (command === "prepare") return runPrepare(rest, io);
  if (command === "check") return runCheck(rest, io);
  if (command === "run") return runRun(rest, io);
  if (command === "launch") return runLaunch(rest, io);
  if (command === "status") return runStatus(rest, io);
  if (command === "log") return runLog(rest, io);
  if (command === "go") return runGo(rest, io);

  io.err(`unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    confirm: process.stdin.isTTY ? confirmOnStdin : undefined,
  });
  process.exit(code);
}
