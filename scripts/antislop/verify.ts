#!/usr/bin/env bun
/**
 * Contract check for a collected audit. Fails on missing evidence, not on findings.
 *
 *   bun scripts/antislop/verify.ts --out <audit-out>
 *
 * Exit: 0 valid, 1 contract violation, 2 schema/parse error. The checks live in
 * `checks.ts` so they can be called without disk; this file is read, call, exit.
 */
import { runVerify } from "./run-verify";

process.exit(
  runVerify(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }),
);
