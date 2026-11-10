/**
 * The lock has to exclude *processes*, not calls: an in-memory mutex passes an in-process test and
 * fails this one, because the two prepares below share no memory (#427). That is the point of
 * spawning real children instead of calling `prepare()` twice in this test.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const child = join(repoRoot, "test/fixtures/batch/prepare-child.ts");

interface ChildResult {
  code: string;
  calls: number;
}

let cwd: string;
let barrier: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mypi-lock-child-"));
  barrier = mkdtempSync(join(tmpdir(), "mypi-lock-barrier-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(barrier, { recursive: true, force: true });
});

/** Run one prepare in its own process; the child prints one JSON line. */
function prepareChild(mode: "hold" | "nohold"): Promise<ChildResult> {
  return new Promise((done, fail) => {
    // The child imports TypeScript, so it runs under bun: running it under whatever runs vitest
    // would depend on node's type-stripping version.
    const proc = spawn("bun", [child, cwd, barrier, mode], { cwd: repoRoot });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      fail(new Error(`child did not finish in time\n${err}`));
    }, 20_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      const line = out.trim().split("\n").pop() ?? "";
      try {
        done(JSON.parse(line) as ChildResult);
      } catch {
        fail(new Error(`child exited ${code} without a verdict\nstdout: ${out}\nstderr: ${err}`));
      }
    });
  });
}

/** Wait for the first child to say it holds the lock, so the second really overlaps it. */
async function waitForClaim(): Promise<void> {
  const until = Date.now() + 15_000;
  while (!existsSync(join(barrier, "claimed"))) {
    if (Date.now() > until) throw new Error("the first prepare never reached the triage call");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const attempts = () => readdirSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/attempts"));

describe("prepare — a second process cannot spend on a ticket being prepared (#427)", () => {
  it("refuses the loser before it calls an agent or writes an attempt", async () => {
    const first = prepareChild("hold");
    await waitForClaim();

    // The loser runs to completion before the winner is let go: releasing first would let the
    // loser take a lock that is genuinely free, which is the behaviour of the second test.
    const loser = await prepareChild("nohold");
    writeFileSync(join(barrier, "go"), "");
    const winner = await first;

    expect(winner).toEqual({ code: "verifier-mismatch", calls: 2 });
    expect(loser.calls).toBe(0);
    expect(loser.code).toBe("already-prepared");
    // One attempt, not two sharing a number: the loser never created its directory.
    expect(attempts()).toEqual(["1"]);
    // The winner's lock is gone once it finished; a stranded lock would block the next prepare.
    expect(existsSync(join(cwd, "mypi-tasks/000-batches/b7/locks/42.lock"))).toBe(false);
  }, 30_000);

  it("lets the next prepare through once the first has finished", async () => {
    await prepareChild("nohold");
    const second = await prepareChild("nohold");

    expect(second).toEqual({ code: "verifier-mismatch", calls: 2 });
    expect(attempts()).toEqual(["1", "2"]);
  }, 30_000);
});
