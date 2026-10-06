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

const config = parseSessionConfig({
  version: "1.1",
  session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85 },
  ask: { title: "t", description: "d", definition_of_done: "dod" },
  agents: [
    { id: "peerA", title: "A", model: "m/m", permissions: { read: true, edit: false, shell: false }, max_cost_usd: 1, system_prompt: "sp" },
    { id: "peerB", title: "B", model: "m/m", permissions: { read: true, edit: false, shell: false }, max_cost_usd: 1, system_prompt: "sp" },
  ],
});

const register = async (rt: Runtime, agentId: string) => {
  const client = connect(rt.bus.path);
  await new Promise<void>((r) => client.once("connect", () => r()));
  const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
  send({ id: `r-${agentId}`, timestamp: 0, sender: agentId, recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId, title: agentId, model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
  await tick();
  return { client, send };
};

describe("await_response", () => {
  it("peer A send_prompt, peer B await_response resolves with the text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "await-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const a = await register(rt, "peerA");
    const b = await register(rt, "peerB");

    const waiting = rt.awaitResponse("peerB", 1000);
    a.send({ id: "p1", timestamp: 0, sender: "peerA", recipient: "peerB", type: "PROMPT", payload: { agentId: "peerB", text: "hello" } });

    await expect(waiting).resolves.toMatchObject({ type: "PROMPT", payload: { agentId: "peerB", text: "hello" } });
    a.client.destroy();
    b.client.destroy();
    await rt.stop();
  });

  it("resolves on an inbound RESPONSE addressed to the caller", async () => {
    const dir = await mkdtemp(join(tmpdir(), "await-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const b = await register(rt, "peerB");

    const waiting = rt.awaitResponse("supervisor", 1000);
    b.send({ id: "r1", correlationId: "c1", timestamp: 0, sender: "peerB", recipient: "supervisor", type: "RESPONSE", payload: { agentId: "peerB", text: "answer" } });

    await expect(waiting).resolves.toMatchObject({ type: "RESPONSE", payload: { text: "answer" } });
    b.client.destroy();
    await rt.stop();
  });

  it("rejects on timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "await-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    await expect(rt.awaitResponse("peerB", 30)).rejects.toThrow("timed out");
    await rt.stop();
  });

  it("rejects immediately when FINALIZING", async () => {
    const dir = await mkdtemp(join(tmpdir(), "await-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    rt.session.enterFinalizing();
    await expect(rt.awaitResponse("peerB", 1000)).rejects.toThrow("finalizing");
    await rt.stop();
  });
});
