/**
 * Integration test: validation across the wired runtime.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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

function configWith(validation?: { commands: string[] }) {
  return parseSessionConfig({
    version: "1.1",
    session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85 },
    ask: { title: "t", description: "d", definition_of_done: ["dod"] },
    agents: [{ id: "peer1", title: "P", model: "m/m", permissions: { read: true, edit: true, shell: false }, max_cost_usd: 1, system_prompt: "sp" }],
    validation,
  });
}

async function setup(exec: (cmd: string) => Promise<boolean>, validation?: { commands: string[] }) {
  const dir = await mkdtemp(join(tmpdir(), "rt-"));
  dirs.push(dir);
  const rt = new Runtime(dir, fakeHerdr, configWith(validation), { execValidation: exec });
  await rt.start();
  const client = connect(rt.bus.path);
  await new Promise<void>((r) => client.once("connect", () => r()));
  const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
  send({ id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId: "peer1", title: "P", model: "m/m", permissions: { read: true, edit: true, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
  await tick();
  const markChanged = () => {
    send({ id: "i1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "INTENT_TO_MODIFY", payload: { agentId: "peer1", filePath: "f.txt", intent: "fix" } });
    return tick();
  };
  return { dir, rt, client, markChanged };
}

const status = async (dir: string) => (await readFile(join(dir, "run-details", "final.md"), "utf8")).match(/status: (\w+)/)?.[1];

const PASS = [{ criterion: "dod", result: "pass" as const, evidence: "verified" }];

describe("validation gates", () => {
  it("no validation config → semantic DoD only", async () => {
    const { dir, rt, client } = await setup(async () => true);
    await rt.finalize(true, undefined, undefined, PASS);
    expect(await status(dir)).toBe("success");
    client.destroy();
  });

  it("validation configured but no code change → skip gate", async () => {
    const exec = vi.fn(async () => true);
    const { dir, rt, client } = await setup(exec, { commands: ["just test"] });
    await rt.finalize(true, undefined, undefined, PASS);
    expect(await status(dir)).toBe("success");
    expect(exec).not.toHaveBeenCalled();
    client.destroy();
  });

  it("code changed and validation passes → success", async () => {
    const exec = vi.fn(async () => true);
    const { dir, rt, client, markChanged } = await setup(exec, { commands: ["just test"] });
    await markChanged();
    await rt.finalize(true, undefined, undefined, PASS);
    expect(await status(dir)).toBe("success");
    expect(exec).toHaveBeenCalledWith("just test");
    client.destroy();
  });

  it("code changed and validation fails → not success even if DoD met", async () => {
    const exec = vi.fn(async () => false);
    const { dir, rt, client, markChanged } = await setup(exec, { commands: ["just test"] });
    await markChanged();
    await rt.finalize(true, undefined, undefined, PASS);
    expect(await status(dir)).toBe("failure");
    client.destroy();
  });
});
