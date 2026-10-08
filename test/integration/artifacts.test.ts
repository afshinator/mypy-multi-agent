/**
 * Integration test: artifacts across the wired runtime.
 */
import { describe, expect, it, afterEach } from "vitest";
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

const config = parseSessionConfig({
  version: "1.1",
  session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85 },
  ask: { title: "t", description: "d", definition_of_done: "dod" },
  agents: [{ id: "peer1", title: "P", model: "m/m", permissions: { read: true, edit: false, shell: false }, max_cost_usd: 1, system_prompt: "sp" }],
});

async function run() {
  const dir = await mkdtemp(join(tmpdir(), "rt-"));
  dirs.push(dir);
  const rt = new Runtime(dir, fakeHerdr, config);
  await rt.start();
  const client = connect(rt.bus.path);
  await new Promise<void>((r) => client.once("connect", () => r()));
  const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
  send({ id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId: "peer1", title: "P", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
  await tick();
  rt.dispatch("peer1", { taskId: "t1", action: "a", contextFiles: [], constraints: [], localDoD: "d" });
  await tick();
  send({ id: "f1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "FINAL_REPORT", payload: { agentId: "peer1", report: "done", usage: { cost: 0.4, tokens: 1200 } } });
  await tick();
  return { dir, rt, client };
}

describe("artifacts", () => {
  it("finalize writes final.md (decision) and findings.md (peer reports)", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true, undefined, "S1: dev_a vs dev_b — picked dev_a.");
    const final = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(final).toContain("status: success");
    expect(final).toContain("exit_code: 0");
    expect(final).toContain("## Decision");
    expect(final).toContain("picked dev_a");
    expect(final).not.toContain("## peer1");
    const findings = await readFile(join(dir, "run-details", "findings.md"), "utf8");
    expect(findings).toContain("## peer1");
    expect(findings).toContain("done");
    client.destroy();
  });

  it("finalize(false) writes a failure final.md", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(false);
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content).toContain("status: failure");
    expect(content).toContain("exit_code: 1");
    client.destroy();
  });

  it("conversation.jsonl logs work order and final report", async () => {
    const { dir, rt, client } = await run();
    await rt.flush();
    const lines = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8")).trim().split("\n");
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain("AGENT_REGISTER");
    expect(types).toContain("WORK_ORDER");
    expect(types).toContain("FINAL_REPORT");
    client.destroy();
  });

  it("finalize logs a FINALIZED marker", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true);
    const lines = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8")).trim().split("\n");
    const finalized = lines.map((l) => JSON.parse(l)).find((e) => e.type === "FINALIZED");
    expect(finalized).toMatchObject({ type: "FINALIZED", outcome: "success", exitCode: 0 });
    client.destroy();
  });

  it("finalize writes supervisor + peer costs into final.md", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true, { costUsd: 1.25, tokens: 5000 });
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content).toContain("total_cost_usd: 1.65");
    expect(content).toContain("total_tokens: 6200");
    expect(content).toContain("supervisor_cost_usd: 1.25");
    expect(content).toContain("supervisor_tokens: 5000");
    expect(content).toContain("- name: peer1");
    expect(content).toContain("cost_usd: 0.4");
    client.destroy();
  });
});
