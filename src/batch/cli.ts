#!/usr/bin/env bun
/**
 * `mypi-batch` entry point. One dispatcher, one verb so far: `new` writes
 * `000-batches/<id>/request.yaml` once. `prepare`, `retemplate` and `run` are not
 * implemented yet and are refused by name, so nobody reads a silent no-op as a
 * finished batch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAgent } from "./agent";
import { runBatch } from "./executor";
import { createHerdr } from "./herdr-cli";
import { batchDirOf, DEFAULT_TASK_DIR, recordRoot, taskDirOf } from "./paths";
import { parsePolicy } from "./policy";
import { resolveModels } from "./preflight";
import { type PrepareDeps, prepare, retriedLabel, type TicketOutcome } from "./prepare";
import { parseRequest, REQUEST_ID, requestYaml } from "./request";
import { createGithubTracker } from "./tracker";
import { createWorktree } from "./worktree";

export interface CliIO {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = [
  "usage: mypi-batch <command>",
  "",
  "  new <id> <ticket...>     write 000-batches/<id>/request.yaml",
  "  prepare <id> [--dry-run] verify each ticket, then comment and label it",
  "  run <id>                 execute the accepted manifests serially",
  "  launch <id> <ticket>     write a halted ticket's manifest into its task dir",
  "",
  "  --dry-run still runs both agents (it is not free); it only skips the writes.",
  "",
  "  retemplate is not implemented yet.",
].join("\n");

function requestPath(cwd: string, id: string): string {
  return join(recordRoot(cwd), id, "request.yaml");
}

function newBatch(argv: string[], io: CliIO): number {
  const [id, ...tickets] = argv;
  if (id === undefined || tickets.length === 0) {
    io.err(`usage: mypi-batch new <id> <ticket...>`);
    return 1;
  }
  const numbers = tickets.map(Number);
  let text: string;
  try {
    if (!REQUEST_ID.test(id)) throw new Error(`id must match ${REQUEST_ID.source}, got "${id}"`);
    text = requestYaml({ id, tickets: numbers });
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }

  const path = requestPath(io.cwd, id);
  const full = join(io.cwd, path);
  if (existsSync(full)) {
    io.err(`${path} already exists — a batch request is written once`);
    return 1;
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  io.out(`wrote ${path}`);
  return 0;
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
      async make() {
        const dir = mkdtempSync(join(tmpdir(), "mypi-triage-"));
        execFileSync("cp", ["-Rc", `${repoRoot}/.`, dir]);
        return dir;
      },
      async remove(dir) {
        rmSync(dir, { recursive: true, force: true });
      },
    },
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
  if (id === undefined) {
    io.err("usage: mypi-batch prepare <id> [--dry-run]");
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

  const outcomes = await prepare({ ...liveDeps(io.cwd), cwd: io.cwd }, policy, request, { dryRun });
  for (const outcome of outcomes) io.out(outcomeLine(outcome));
  return outcomes.every((o) => o.ok) ? 0 : 1;
}

async function runRun(argv: string[], io: CliIO): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("--"));
  if (id === undefined) {
    io.err("usage: mypi-batch run <id>");
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
    },
    request,
  );
  for (const o of outcomes) {
    const detail = [o.exitCode === undefined ? "" : `exit ${o.exitCode}`, o.detail ?? ""]
      .filter(Boolean)
      .join(" ");
    io.out(`${o.ticket}\t${o.code}\t${detail}`.trimEnd());
  }
  return outcomes.every((o) => o.code === "success") ? 0 : 1;
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
    const slug = `b-${id}-t${ticket}`;
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

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    io.out(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "new") return newBatch(rest, io);
  if (command === "prepare") return runPrepare(rest, io);
  if (command === "run") return runRun(rest, io);
  if (command === "launch") return runLaunch(rest, io);

  io.err(`unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exit(code);
}
