#!/usr/bin/env bun
/**
 * `mypi-batch` entry point. One dispatcher, one verb so far: `new` writes
 * `batches/<id>/request.yaml` once. `prepare`, `retemplate` and `run` are not
 * implemented yet and are refused by name, so nobody reads a silent no-op as a
 * finished batch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAgent } from "./agent";
import { parsePolicy } from "./policy";
import { resolveModels } from "./preflight";
import { type PrepareDeps, prepare } from "./prepare";
import { parseRequest, REQUEST_ID, requestYaml } from "./request";
import { createGithubTracker } from "./tracker";

export interface CliIO {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = [
  "usage: mypi-batch <command>",
  "",
  "  new <id> <ticket...>     write batches/<id>/request.yaml",
  "  prepare <id> [--dry-run] verify each ticket, then comment and label it",
  "",
  "  --dry-run still runs both agents (it is not free); it only skips the writes.",
  "",
  "  retemplate and run are not implemented yet.",
].join("\n");

function requestPath(id: string): string {
  return join("batches", id, "request.yaml");
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

  const path = requestPath(id);
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
    repoRoot,
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

async function runPrepare(argv: string[], io: CliIO): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("--"));
  const dryRun = argv.includes("--dry-run");
  if (id === undefined) {
    io.err("usage: mypi-batch prepare <id> [--dry-run]");
    return 1;
  }

  const policyPath = join(io.cwd, "mypi-batch.yaml");
  const requestPath = join(io.cwd, "batches", id, "request.yaml");
  let policy: ReturnType<typeof parsePolicy>;
  let request: ReturnType<typeof parseRequest>;
  try {
    policy = parsePolicy(readFileSync(policyPath, "utf8"));
    request = parseRequest(readFileSync(requestPath, "utf8"));
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }

  const outcomes = await prepare({ ...liveDeps(io.cwd), cwd: io.cwd }, policy, request, { dryRun });
  for (const o of outcomes) {
    const verdict = o.ok ? "ok" : (o.code ?? "refused");
    const detail = o.ok
      ? `${o.kind}${o.slug === undefined ? "" : ` ${o.slug}`} ${o.criteria?.length ?? 0} criteria`
      : (o.detail ?? "");
    io.out(`${o.ticket}\t${verdict}\t${detail}`);
  }
  return outcomes.every((o) => o.ok) ? 0 : 1;
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    io.out(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "new") return newBatch(rest, io);
  if (command === "prepare") return runPrepare(rest, io);

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
