/**
 * Integration test: abort across the wired runtime.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { Runtime } from "../../src/runtime/runtime";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import { EXIT } from "../../src/runtime/exit";
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
  ask: { title: "t", description: "d", definition_of_done: ["dod"] },
  agents: [{ id: "peer1", title: "P", model: "m/m", permissions: { read: true, edit: false, shell: false }, max_cost_usd: 1, system_prompt: "sp" }],
});

describe("abort", () => {
  it("abort writes an aborted final.md and returns exit 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, config, { sleep: async () => {}, abortGraceMs: 0 });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
    send({ id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId: "peer1", title: "P", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
    await tick();
    client.destroy(); // peer dies before teardown (so bus.stop can close)
    await tick();

    const code = await rt.abort();
    expect(code).toBe(EXIT.USER_ABORTED);
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content).toContain("status: aborted");
    expect(content).toContain("exit_code: 2");
  });
});
