/**
 * Integration test: budget across the wired runtime.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { Runtime } from "../../src/runtime/runtime";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};
const tick = () => new Promise((r) => setTimeout(r, 30));

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function makeConfig(opts: { agentMaxCost?: number; agentMaxTokens?: number; sessionMaxCost?: number } = {}) {
  return parseSessionConfig({
    version: "1.1",
    session: { id: "s", max_cost_usd: opts.sessionMaxCost ?? 5, agent_stop_threshold_percent: 85 },
    ask: { title: "t", description: "d", definition_of_done: "dod" },
    agents: [
      {
        id: "peer1",
        title: "P",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: opts.agentMaxCost ?? 1,
        max_tokens: opts.agentMaxTokens,
        system_prompt: "sp",
      },
    ],
  });
}

async function report(cfg: ReturnType<typeof makeConfig>, usage: { cost: number; tokens: number }) {
  const dir = await mkdtemp(join(tmpdir(), "rt-"));
  dirs.push(dir);
  const rt = new Runtime(dir, fakeHerdr, cfg);
  await rt.start();
  const received: string[] = [];
  const client = connect(rt.bus.path);
  client.on("data", (d) => received.push(d.toString()));
  await new Promise<void>((r) => client.once("connect", () => r()));
  const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
  send({ id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId: "peer1", title: "P", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
  await tick();
  send({ id: "f1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "FINAL_REPORT", payload: { agentId: "peer1", report: "done", usage } });
  await tick();
  return { rt, received, client };
}

describe("budget enforcement", () => {
  it("records peer usage into accounting", async () => {
    const { rt, client } = await report(makeConfig(), { cost: 0.5, tokens: 100 });
    expect(rt.accounting.getAgentCost("peer1")).toBe(0.5);
    expect(rt.accounting.getAgentTokens("peer1")).toBe(100);
    client.destroy();
  });

  it("agent cost threshold emits STOP_AGENT", async () => {
    const { received, client } = await report(makeConfig({ agentMaxCost: 1 }), { cost: 0.9, tokens: 0 });
    expect(received.some((f) => f.includes("STOP_AGENT"))).toBe(true);
    client.destroy();
  });

  it("free model trips the token threshold (cost 0)", async () => {
    const { received, client } = await report(makeConfig({ agentMaxCost: 10, agentMaxTokens: 100 }), { cost: 0, tokens: 90 });
    expect(received.some((f) => f.includes("STOP_AGENT"))).toBe(true);
    client.destroy();
  });

  it("global budget emits STOP_ALL", async () => {
    const { received, client } = await report(makeConfig({ agentMaxCost: 10, sessionMaxCost: 5 }), { cost: 6, tokens: 0 });
    expect(received.some((f) => f.includes("STOP_ALL"))).toBe(true);
    client.destroy();
  });
});
