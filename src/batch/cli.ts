#!/usr/bin/env bun
/**
 * `mypi-batch` entry point. One dispatcher, one verb so far: `new` writes
 * `batches/<id>/request.yaml` once. `prepare`, `retemplate` and `run` are not
 * implemented yet and are refused by name, so nobody reads a silent no-op as a
 * finished batch.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REQUEST_ID, requestYaml } from "./request";

export interface CliIO {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = [
  "usage: mypi-batch <command>",
  "",
  "  new <id> <ticket...>     write batches/<id>/request.yaml",
  "",
  "  prepare, retemplate and run are not implemented yet.",
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

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    io.out(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "new") return newBatch(rest, io);

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
