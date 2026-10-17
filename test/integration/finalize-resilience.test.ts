/**
 * Integration test: finalize survives failures on its non-essential and
 * essential writes (issue #24).
 *
 * Seam: Runtime.finalize() plus the public session phase. Nothing here reaches
 * into private state or mocks an internal collaborator; the proof is the
 * artifact on disk and whether a second finalize is possible.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";
import { Runtime } from "../../src/runtime/runtime";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};

const config = parseSessionConfig({
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

const PASS = [{ criterion: "dod", result: "pass" as const, evidence: "verified" }];

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.stop().catch(() => {});
  rt = undefined;
});

/** A started runtime whose run dir already satisfies the run contract. */
async function startedRun(kind: "log" | "artifact"): Promise<{ dir: string; rt: Runtime }> {
  const dir = await mkdtemp(join(tmpdir(), "fin-"));
  const runDetails = join(dir, "run-details");
  await mkdir(runDetails, { recursive: true });
  await writeFile(join(runDetails, "plan.md"), "plan\n");
  // Poison a path by making it a directory, so writes there fail with EISDIR.
  const poisoned = kind === "log" ? "conversation.jsonl" : "final.md";
  await mkdir(join(runDetails, poisoned), { recursive: true });
  rt = new Runtime(dir, fakeHerdr, config);
  await rt.start();
  return { dir, rt };
}

/** A started runtime whose validation gate is armed, with a 200 ms command bound. */
async function startedRunWithValidation(command: string): Promise<{ dir: string; rt: Runtime }> {
  const dir = await mkdtemp(join(tmpdir(), "fin-"));
  await mkdir(join(dir, "run-details"), { recursive: true });
  await writeFile(join(dir, "run-details", "plan.md"), "plan\n");
  const withValidation = parseSessionConfig({
    version: "1.1",
    session: {
      id: "s",
      max_cost_usd: 5,
      agent_stop_threshold_percent: 85,
      attester: "peer1",
      finalization_grace_ms: 200,
    },
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
    validation: { commands: [command] },
  });
  rt = new Runtime(dir, fakeHerdr, withValidation);
  await rt.start();
  // The INTENT_TO_MODIFY -> markChanged route is covered in runtime.test.ts;
  // here the concern is the command bound, so arm the gate directly.
  rt.changeDetector.markChanged();
  return { dir, rt };
}

describe("finalize resilience", () => {
  it("writes final.md when the log cannot be appended to (issue #24)", async () => {
    const { dir, rt } = await startedRun("log");
    await rt.finalize(true, undefined, undefined, PASS);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 0");
  });

  it("stays retryable when the artifact write fails (issue #24)", async () => {
    const { dir, rt } = await startedRun("artifact");
    await expect(rt.finalize(true, undefined, undefined, PASS)).rejects.toThrow(/EISDIR/);
    // Not COMPLETE: the terminal state is earned by the artifact, not the attempt.
    expect(rt.session.current).toBe("FINALIZING");
    expect(existsSync(join(dir, "run-details", "final.md"))).toBe(true);

    await rm(join(dir, "run-details", "final.md"), { recursive: true, force: true });
    await rt.finalize(true, undefined, undefined, PASS);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 0");
  });

  it("fails the gate instead of hanging when a validation command never exits (issue #25)", async () => {
    const { dir, rt } = await startedRunWithValidation("sleep 30");
    // Pre-fix this never settles: the exec has no bound, so finalize waits forever.
    await rt.finalize(true, undefined, undefined, PASS);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 1");
  }, 5000);

  it("still passes the gate for a command that exits in time (issue #25)", async () => {
    const { dir, rt } = await startedRunWithValidation("true");
    await rt.finalize(true, undefined, undefined, PASS);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 0");
  });
});
