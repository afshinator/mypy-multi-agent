/**
 * Unit tests for the run-state snapshot contract: build -> write -> read round-trip,
 * fail-loud parsing, and the pure resume briefing.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAccounting } from "../../src/budget/usage-accounting";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import {
  buildResumeBriefing,
  buildRunState,
  hashConfig,
  readRunState,
  writeRunState,
} from "../../src/runtime/run-state";

const config = parseSessionConfig({
  version: "1.1",
  session: { id: "s1", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "peer1" },
  ask: { title: "t", description: "d", definition_of_done: ["dod"] },
  agents: [
    {
      id: "peer1",
      title: "P1",
      model: "m/m",
      permissions: { read: true, edit: false, shell: false },
      max_cost_usd: 1,
      max_tokens: 100,
      system_prompt: "sp",
    },
  ],
});

describe("run-state", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("build -> write -> read round-trips deep-equal", async () => {
    const accounting = new UsageAccounting();
    accounting.recordUsage({ agentId: "peer1", cost: 0.5, tokens: 100, cacheReadTokens: 30 });
    const state = buildRunState({
      config,
      rawSessionYaml: "session: yaml\n",
      accounting,
      states: new Map([["peer1", "DONE"]]),
      startedAtMs: 0,
      lastCompletedWorkOrder: new Map([["peer1", "task-1"]]),
    });

    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    await writeRunState(dir, state);
    const read = await readRunState(dir);

    expect(read).toEqual(state);
    const raw = JSON.parse(await readFile(join(dir, "run-state.json"), "utf8"));
    expect(raw.version).toBe("1");
    expect(raw.configHash).toBe(hashConfig("session: yaml\n"));
    expect(raw.planPointer).toBe("run-details/plan.md");
    expect(raw.agents[0].usage).toEqual({ costUsd: 0.5, tokens: 100, cacheReadTokens: 30 });
    expect(raw.agents[0].budget).toEqual({ maxCostUsd: 1, maxTokens: 100 });
    expect(raw.agents[0].lastCompletedWorkOrder).toBe("task-1");
    expect(raw.agents[0].inFlightTaskId).toBeNull();
  });

  it("carries the base commit so an aggregate diff has a fixed base", async () => {
    const accounting = new UsageAccounting();
    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    await writeRunState(
      dir,
      buildRunState({
        config,
        rawSessionYaml: "session: yaml\n",
        accounting,
        states: new Map([["peer1", "PENDING"]]),
        startedAtMs: 0,
        baseCommit: "1f2e3d4c5b6a7f8091a2b3c4d5e6f708192a3b4c",
      }),
    );
    expect((await readRunState(dir)).baseCommit).toBe("1f2e3d4c5b6a7f8091a2b3c4d5e6f708192a3b4c");

    const bare = buildRunState({
      config,
      rawSessionYaml: "session: yaml\n",
      accounting,
      states: new Map([["peer1", "PENDING"]]),
      startedAtMs: 0,
    });
    expect(bare.baseCommit).toBeUndefined();
  });

  it("fails loud on a bad version", async () => {
    const accounting = new UsageAccounting();
    const state = buildRunState({
      config,
      rawSessionYaml: "y",
      accounting,
      states: new Map(),
      startedAtMs: 0,
    });
    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    await writeFile(join(dir, "run-state.json"), JSON.stringify({ ...state, version: "2" }));
    await expect(readRunState(dir)).rejects.toThrow();
  });

  it("fails loud on bad JSON", async () => {
    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    await writeFile(join(dir, "run-state.json"), "{not json\n");
    await expect(readRunState(dir)).rejects.toThrow(/not valid JSON/);
  });

  it("fails loud on a missing snapshot", async () => {
    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    await expect(readRunState(dir)).rejects.toThrow(/not found/);
  });

  it("hashConfig is sha256 of the raw yaml", () => {
    expect(hashConfig("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("resume briefing names what could not be recovered and does not re-dispatch", () => {
    const accounting = new UsageAccounting();
    accounting.recordUsage({ agentId: "peer1", cost: 1.25, tokens: 200 });
    const state = buildRunState({
      config,
      rawSessionYaml: "y",
      accounting,
      states: new Map([["peer1", "DONE"]]),
      startedAtMs: 0,
      lastCompletedWorkOrder: new Map([["peer1", "task-3"]]),
      inFlightTaskIds: new Map([["peer1", "task-4"]]),
    });
    const out = buildResumeBriefing(state, "the plan text");
    expect(out).toContain("the plan text");
    expect(out).toContain("task-3");
    expect(out).toContain("SPEND ALREADY BOOKED: $1.2500 / 200 tokens");
    expect(out).toContain("WHAT COULD NOT BE RECOVERED");
    expect(out).toContain("peer conversation context");
    expect(out).toContain("file locks");
    expect(out).toContain("in-flight edits");
    expect(out).toContain("git status");
    expect(out).toContain("no work order has been re-dispatched");
    expect(out).toContain("NOT re-dispatched");
  });
});
