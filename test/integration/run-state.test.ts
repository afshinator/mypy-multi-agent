/**
 * Integration tests for the wired run-state boundaries: snapshot at dispatch and
 * FINAL_REPORT, rehydrate on resume, and the explicit-only guard that
 * Runtime.start() never reads run-state.json.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageAccounting } from "../../src/budget/usage-accounting";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";
import { sumSupervisorUsage } from "../../src/pi/supervisor-usage";
import {
  buildRunState,
  type RunStateV1,
  readRunState,
  writeRunState,
} from "../../src/runtime/run-state";
import { Runtime } from "../../src/runtime/runtime";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p1",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};

const rawYaml = "session: yaml\n";

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

const reg = (id: string) => ({
  id: `r-${id}`,
  timestamp: 0,
  sender: id,
  recipient: "supervisor",
  type: "AGENT_REGISTER",
  payload: {
    agentId: id,
    title: id,
    model: "m/m",
    permissions: { read: true, edit: false, shell: false },
    maxCostUsd: 1,
    systemPrompt: "sp",
  },
});

const tick = () => new Promise((r) => setTimeout(r, 50));

function oneAgent(state: RunStateV1) {
  const agent = state.agents[0];
  if (agent === undefined) throw new Error("snapshot has no agent");
  return agent;
}

describe("run-state boundaries", () => {
  let dir: string | undefined;
  let rt: Runtime | undefined;

  afterEach(async () => {
    await rt?.stop().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes the snapshot at dispatch and FINAL_REPORT boundaries", async () => {
    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    const runDir = dir;
    rt = new Runtime(runDir, fakeHerdr, config, { sessionYaml: rawYaml });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();

    expect(
      rt.dispatch("peer1", {
        taskId: "task-1",
        action: "a",
        contextFiles: [],
        constraints: [],
        localDoD: "d",
      }),
    ).toBe(true);
    await vi.waitFor(async () => {
      const s = await readRunState(join(runDir, "run-details"));
      expect(oneAgent(s).inFlightTaskId).toBe("task-1");
      expect(oneAgent(s).lastCompletedWorkOrder).toBeNull();
    });

    client.write(
      `${JSON.stringify({ id: "f1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "FINAL_REPORT", payload: { agentId: "peer1", report: "done", usage: { cost: 0.5, tokens: 100, cacheReadTokens: 30 } } })}\n`,
    );
    await vi.waitFor(async () => {
      const s = await readRunState(join(runDir, "run-details"));
      const agent = oneAgent(s);
      expect(agent.lastCompletedWorkOrder).toBe("task-1");
      expect(agent.inFlightTaskId).toBeNull();
      expect(agent.usage.costUsd).toBeCloseTo(0.5);
      expect(agent.usage.tokens).toBe(100);
      expect(agent.usage.cacheReadTokens).toBe(30);
      expect(s.totals.costUsd).toBeCloseTo(0.5);
    });
    client.destroy();
  });

  it("resume rehydrates accounting totals and agent states", async () => {
    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    const accounting = new UsageAccounting();
    accounting.recordUsage({ agentId: "peer1", cost: 0.5, tokens: 100, cacheReadTokens: 30 });
    const state = buildRunState({
      config,
      rawSessionYaml: rawYaml,
      accounting,
      states: new Map([["peer1", "DONE"]]),
      startedAtMs: 0,
      lastCompletedWorkOrder: new Map([["peer1", "task-1"]]),
    });
    await mkdir(join(dir, "run-details"), { recursive: true });
    await writeRunState(join(dir, "run-details"), state);

    const commands: string[] = [];
    const herdr: HerdrClient = {
      createPane: async () => "p1",
      runCommand: async (_pane, cmd) => void commands.push(cmd),
      reportMetadata: async () => {},
      closePane: async () => {},
    };
    rt = new Runtime(dir, herdr, config, { sessionYaml: rawYaml });
    await rt.resume(state);

    expect(rt.accounting.getAgentCost("peer1")).toBeCloseTo(0.5);
    expect(rt.accounting.getAgentTokens("peer1")).toBe(100);
    expect(rt.accounting.getAgentCacheReadTokens("peer1")).toBe(30);
    expect(rt.accounting.getSessionCost()).toBeCloseTo(0.5);
    expect(rt.states.get("peer1")).toBe("DONE");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--config");
  });

  it("resume restores the accounting boundary and re-counts only resumed cost", async () => {
    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    const accounting = new UsageAccounting();
    const startedAtMs = 1_700_000_000_000;
    const state = buildRunState({
      config,
      rawSessionYaml: rawYaml,
      accounting,
      states: new Map(),
      startedAtMs,
    });
    expect(state.startedAtMs).toBe(startedAtMs);

    await mkdir(join(dir, "run-details"), { recursive: true });
    await writeRunState(join(dir, "run-details"), state);
    expect((await readRunState(join(dir, "run-details"))).startedAtMs).toBe(startedAtMs);

    const herdr: HerdrClient = {
      createPane: async () => "p1",
      runCommand: async () => {},
      reportMetadata: async () => {},
      closePane: async () => {},
    };
    rt = new Runtime(dir, herdr, config, { sessionYaml: rawYaml });
    await rt.resume(state);

    // The persisted boundary survives, but elapsedMs still starts fresh at
    // resume (the run clock is separate from the accounting boundary).
    expect(rt.accountingStartedAtMs()).toBe(startedAtMs);
    expect(rt.elapsedMs()).toBeLessThan(5_000);

    // Production wiring: only assistant messages at/after the boundary count.
    const entries = [
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2023-01-01T00:00:00.000Z",
        message: { role: "assistant", usage: { cost: { total: 0.5 }, totalTokens: 100 } },
      },
      {
        type: "message",
        id: "m2",
        parentId: null,
        timestamp: "2024-01-01T00:00:00.000Z",
        message: { role: "assistant", usage: { cost: { total: 0.75 }, totalTokens: 200 } },
      },
    ] as never;
    expect(sumSupervisorUsage(entries, rt.accountingStartedAtMs())).toEqual({
      costUsd: 0.75,
      tokens: 200,
    });
  });

  it("legacy snapshot without startedAtMs resumes with boundary 0 so no cost is dropped", async () => {
    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    const accounting = new UsageAccounting();
    const state = buildRunState({
      config,
      rawSessionYaml: rawYaml,
      accounting,
      states: new Map(),
      startedAtMs: 0,
    });
    await mkdir(join(dir, "run-details"), { recursive: true });
    await writeRunState(join(dir, "run-details"), state);
    const raw = JSON.parse(await readFile(join(dir, "run-details", "run-state.json"), "utf8"));
    delete raw.startedAtMs;
    await writeFile(join(dir, "run-details", "run-state.json"), JSON.stringify(raw));

    const legacy = await readRunState(join(dir, "run-details"));
    expect(legacy.startedAtMs).toBeUndefined();

    const herdr: HerdrClient = {
      createPane: async () => "p1",
      runCommand: async () => {},
      reportMetadata: async () => {},
      closePane: async () => {},
    };
    rt = new Runtime(dir, herdr, config, { sessionYaml: rawYaml });
    await rt.resume(legacy);
    expect(rt.accountingStartedAtMs()).toBe(0);
  });

  it("Runtime.start() never reads run-state.json (explicit-only guard)", async () => {
    dir = await mkdtemp(join(tmpdir(), "run-state-"));
    await mkdir(join(dir, "run-details"), { recursive: true });
    // A broken snapshot would throw if start() read it; start() must ignore it.
    await writeFile(join(dir, "run-details", "run-state.json"), "not json at all");

    rt = new Runtime(dir, fakeHerdr, config, { sessionYaml: rawYaml });
    await expect(rt.start()).resolves.toBeUndefined();
    expect(existsSync(rt.bus.path)).toBe(true);
    const snapshot = await readFile(join(dir, "run-details", "run-state.json"), "utf8");
    expect(snapshot).toBe("not json at all");
  });
});
