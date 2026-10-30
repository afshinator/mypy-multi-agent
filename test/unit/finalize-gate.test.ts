/**
 * The Finalize gate's own seams: attester trust (captureVerdicts) and the
 * five-term decision (evaluate) including citation staleness. The orchestration
 * these replace was only ever exercised through Runtime.finalize with a bypass
 * parameter; these tests pin the trust rule and the citation resolution that
 * were private and untested before the fold.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CriterionVerdict } from "../../src/contracts/criteria";
import { parseSessionConfig, type SessionConfig } from "../../src/contracts/session-schema";
import { SessionState } from "../../src/control/session-state";
import { FinalizeGate } from "../../src/runtime/finalize-gate";
import { Reconciliation } from "../../src/supervisor/reconciliation";
import type { SpanHandle, Tracing } from "../../src/tracing/tracing";

const fakeTracer: Tracing = {
  startSpan: () => ({ id: "s" }),
  endSpan: () => {},
  inject: () => {},
  extract: () => null,
  collect: () => [],
};

const PASS: CriterionVerdict[] = [{ criterion: "dod", result: "pass", evidence: "verified" }];

const makeConfig = (): SessionConfig =>
  parseSessionConfig({
    version: "1.1",
    session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "peer1" },
    ask: { title: "t", description: "d", definition_of_done: ["dod"] },
    agents: [
      {
        id: "peer1",
        title: "P",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: 1,
        system_prompt: "sp",
      },
    ],
  });

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A gate wired for decision tests: real paths, everything else a no-op fake. */
async function makeGate(log: Array<Record<string, unknown>> = []) {
  const dir = await mkdtemp(join(tmpdir(), "fg-"));
  dirs.push(dir);
  const workspaceRoot = join(dir, "ws");
  const runDetailsDir = join(dir, "task", "run-details");
  const askDir = join(dir, "task");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(runDetailsDir, { recursive: true });
  await writeFile(join(runDetailsDir, "plan.md"), "plan");
  const gate = new FinalizeGate({
    config: makeConfig(),
    workspaceRoot,
    runDetailsDir,
    askDir,
    session: new SessionState(),
    tracer: fakeTracer,
    currentSpan: () => null,
    hasChanged: () => false,
    execValidation: async () => true,
    log: (entry) => log.push(entry),
    flush: async () => {},
    reconciliation: new Reconciliation(),
    now: Date.now,
  });
  return { gate, workspaceRoot, runDetailsDir, log };
}

describe("captureVerdicts — attester trust", () => {
  it("accepts the attester's block and exposes it", async () => {
    const { gate } = await makeGate();
    gate.captureVerdicts("peer1", PASS);
    expect(gate.attestedCriteria).toBe(PASS);
  });

  it("rejects a non-attester block and logs the rejection", async () => {
    const { gate, log } = await makeGate();
    gate.captureVerdicts("peer2", PASS);
    expect(gate.attestedCriteria).toBeUndefined();
    expect(log.some((e) => e.event === "non-attester-verdict" && e.agentId === "peer2")).toBe(true);
  });
});

describe("evaluate — the five-term decision", () => {
  it("passes when the DoD is met, the attester block matches, and the contract holds", async () => {
    const { gate } = await makeGate();
    gate.captureVerdicts("peer1", PASS);
    const result = await gate.evaluate(true, undefined, undefined, undefined);
    expect(result.success).toBe(true);
    expect(result.failingTerms).toEqual([]);
  });

  it("flags a citation whose file was modified after the block was captured", async () => {
    const { gate, workspaceRoot } = await makeGate();
    const cited = join(workspaceRoot, "evidence.txt");
    await writeFile(cited, "evidence");
    gate.captureVerdicts("peer1", [
      { criterion: "dod", result: "pass", evidence: "evidence.txt:1" },
    ]);
    // Touch the cited file to a future mtime: the verdict describes a tree that
    // no longer exists, so the stale-attestation term must fail the gate.
    const future = new Date(Date.now() + 60_000);
    await utimes(cited, future, future);
    const result = await gate.evaluate(true, undefined, undefined, undefined);
    expect(result.success).toBe(false);
    expect(result.failingTerms.map((t) => t.name)).toContain("stale-attestation");
  });
});
