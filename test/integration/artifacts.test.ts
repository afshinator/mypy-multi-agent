/**
 * Integration test: artifacts across the wired runtime.
 */

import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { connect } from "node:net";
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
const tick = () => new Promise((r) => setTimeout(r, 30));
const PASS = [{ criterion: "dod", result: "pass" as const, evidence: "verified" }];

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

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

async function run() {
  const dir = await mkdtemp(join(tmpdir(), "rt-"));
  dirs.push(dir);
  const rt = new Runtime(dir, fakeHerdr, config);
  await rt.start();
  await writeFile(join(dir, "run-details", "plan.md"), "plan\n"); // run-contract artifact
  const client = connect(rt.bus.path);
  await new Promise<void>((r) => client.once("connect", () => r()));
  const send = (env: unknown) => client.write(`${JSON.stringify(env)}\n`);
  send({
    id: "r1",
    timestamp: 0,
    sender: "peer1",
    recipient: "supervisor",
    type: "AGENT_REGISTER",
    payload: {
      agentId: "peer1",
      title: "P",
      model: "m/m",
      permissions: { read: true, edit: false, shell: false },
      maxCostUsd: 1,
      systemPrompt: "sp",
    },
  });
  await tick();
  rt.dispatch("peer1", {
    taskId: "t1",
    action: "a",
    contextFiles: [],
    constraints: [],
    localDoD: "d",
  });
  await tick();
  send({
    id: "f1",
    timestamp: 0,
    sender: "peer1",
    recipient: "supervisor",
    type: "FINAL_REPORT",
    payload: { agentId: "peer1", report: "done", usage: { cost: 0.4, tokens: 1200 } },
  });
  await tick();
  return { dir, rt, client };
}

const responseWithCriteria = (from: string, criteria: unknown = PASS) => ({
  id: `c-${from}`,
  timestamp: 0,
  sender: from,
  recipient: "supervisor",
  type: "RESPONSE",
  payload: { agentId: from, text: "ok", criteria },
});

/** Two peers with `reviewer` designated attester; registers `sender` on the bus
 * so its RESPONSE passes the connection's sender check (RT-8 R10). */
async function runTwoAgents(sender: string) {
  const dir = await mkdtemp(join(tmpdir(), "rt-"));
  dirs.push(dir);
  const cfg = parseSessionConfig({
    version: "1.1",
    session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "reviewer" },
    ask: { title: "t", description: "d", definition_of_done: ["dod"] },
    agents: ["peer1", "reviewer"].map((id) => ({
      id,
      title: id,
      model: "m/m",
      permissions: { read: true, edit: false, shell: false },
      max_cost_usd: 1,
      system_prompt: "sp",
    })),
  });
  const rt = new Runtime(dir, fakeHerdr, cfg);
  await rt.start();
  await writeFile(join(dir, "run-details", "plan.md"), "plan\n");
  const client = connect(rt.bus.path);
  await new Promise<void>((r) => client.once("connect", () => r()));
  const send = (env: unknown) => client.write(`${JSON.stringify(env)}\n`);
  send({
    id: `reg-${sender}`,
    timestamp: 0,
    sender,
    recipient: "supervisor",
    type: "AGENT_REGISTER",
    payload: {
      agentId: sender,
      title: sender,
      model: "m/m",
      permissions: { read: true, edit: false, shell: false },
      maxCostUsd: 1,
      systemPrompt: "sp",
    },
  });
  await tick();
  return { dir, rt, client, send };
}

describe("artifacts", () => {
  it("finalize writes final.md (decision) and findings.md (peer reports)", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true, undefined, "S1: dev_a vs dev_b — picked dev_a.", PASS);
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

  it("advisory flags every criterion but the deterministic gate still writes exit_code 0", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true, undefined, undefined, PASS, undefined, {
      model: "openrouter/typesafe/jev-1.13",
      threshold: 0.5,
      flagged: 1,
      perCriterion: [{ criterion: "dod", establishes: 0.1, flagged: true }],
    });
    const final = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(final).toContain("exit_code: 0");
    expect(final).toContain("## Advisory");
    client.destroy();
  });

  it("a failed DoD criterion forces exit 1 even with dod=true", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true, undefined, "d", [
      { criterion: "dod", result: "fail", evidence: "not done" },
    ]);
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content).toContain("exit_code: 1");
    expect(content).toContain("## Criteria");
    expect(content).toContain("[ ] dod — not done");
    client.destroy();
  });

  it("a bus-attested reviewer verdict gates the run (no finalize argument)", async () => {
    const { dir, rt, client } = await run();
    client.write(
      `${JSON.stringify({
        id: "c1",
        timestamp: 0,
        sender: "peer1",
        recipient: "supervisor",
        type: "RESPONSE",
        payload: {
          agentId: "peer1",
          text: "ok",
          criteria: [{ criterion: "dod", result: "pass", evidence: "x" }],
        },
      })}\n`,
    );
    await tick();
    await rt.finalize(true);
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content).toContain("exit_code: 0");
    client.destroy();
  });

  it("O2: rejects a verdict whose cited evidence changed after it was captured", async () => {
    const { dir, rt, client, send } = await runTwoAgents("reviewer");
    const cited = join(dir, "run-details", "latency-log.md");
    await writeFile(cited, "row 1\n");
    // Deterministic: the attestation reads a file older than its capture instant.
    await utimes(cited, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    send(
      responseWithCriteria("reviewer", [
        { criterion: "dod", result: "pass", evidence: "run-details/latency-log.md:1" },
      ]),
    );
    await tick();
    // The run keeps moving after the attestation: the cited artifact changes.
    await writeFile(cited, "row 1\nrow 2\n");
    await utimes(cited, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    await rt.finalize(true);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 1");
    expect(await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8")).toContain(
      "stale-attestation",
    );
    client.destroy();
  });

  it("O2: accepts a verdict whose cited evidence is untouched", async () => {
    const { dir, rt, client, send } = await runTwoAgents("reviewer");
    const cited = join(dir, "run-details", "latency-log.md");
    await writeFile(cited, "row 1\n");
    // Deterministic: clearly older than the capture instant below.
    await utimes(cited, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    send(
      responseWithCriteria("reviewer", [
        { criterion: "dod", result: "pass", evidence: "run-details/latency-log.md:1" },
      ]),
    );
    await tick();
    await rt.finalize(true);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 0");
    client.destroy();
  });

  it("O2: a cited append-only log that grew does not fail the run", async () => {
    const { dir, rt, client, send } = await runTwoAgents("reviewer");
    send(
      responseWithCriteria("reviewer", [
        {
          criterion: "dod",
          result: "pass",
          evidence: "run-details/conversation.jsonl:58",
        },
      ]),
    );
    await tick();
    await rt.finalize(true);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 0");
    client.destroy();
  });

  it("trusts the designated attester's verdict block (RT-8 R10)", async () => {
    const { dir, rt, client, send } = await runTwoAgents("reviewer");
    send(responseWithCriteria("reviewer"));
    await tick();
    await rt.finalize(true);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 0");
    client.destroy();
  });

  it("ignores and logs a verdict block from a non-attester (RT-8 R10)", async () => {
    const { dir, rt, client, send } = await runTwoAgents("peer1");
    send(responseWithCriteria("peer1"));
    await tick();
    await rt.finalize(true);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 1");
    expect(await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8")).toContain(
      "non-attester-verdict",
    );
    client.destroy();
  });

  it("trusts an attestation delivered as a work-order FINAL_REPORT (RT-9 G2)", async () => {
    const { dir, rt, client, send } = await runTwoAgents("reviewer");
    send({
      id: "fr",
      timestamp: 0,
      sender: "reviewer",
      recipient: "supervisor",
      type: "FINAL_REPORT",
      payload: { agentId: "reviewer", report: "attested", criteria: PASS },
    });
    await tick();
    await rt.finalize(true);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 0");
    client.destroy();
  });

  it("an empty verdict block is not an attestation (RT-9 G1)", async () => {
    const { dir, rt, client, send } = await runTwoAgents("reviewer");
    send(responseWithCriteria("reviewer", []));
    await tick();
    await rt.finalize(true);
    expect(await readFile(join(dir, "run-details", "final.md"), "utf8")).toContain("exit_code: 1");
    client.destroy();
  });

  it("a missing run-contract artifact fails the run even with passing criteria", async () => {
    const { dir, rt, client } = await run();
    await rm(join(dir, "run-details", "plan.md"));
    client.write(
      `${JSON.stringify({
        id: "c1",
        timestamp: 0,
        sender: "peer1",
        recipient: "supervisor",
        type: "RESPONSE",
        payload: {
          agentId: "peer1",
          text: "ok",
          criteria: [{ criterion: "dod", result: "pass", evidence: "x" }],
        },
      })}\n`,
    );
    await tick();
    await rt.finalize(true);
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content).toContain("exit_code: 1");
    client.destroy();
  });

  it("no reviewer attestation means dod=true is not success", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true);
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content).toContain("exit_code: 1");
    client.destroy();
  });

  it("all-pass criteria yield exit 0 and render the checklist", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true, undefined, "d", [
      { criterion: "dod", result: "pass", evidence: "verified" },
    ]);
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content).toContain("exit_code: 0");
    expect(content).toContain("[x] dod — verified");
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
    const lines = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8"))
      .trim()
      .split("\n");
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain("AGENT_REGISTER");
    expect(types).toContain("WORK_ORDER");
    expect(types).toContain("FINAL_REPORT");
    client.destroy();
  });

  it("finalize logs a FINALIZED marker", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true, undefined, undefined, PASS);
    const lines = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8"))
      .trim()
      .split("\n");
    const finalized = lines.map((l) => JSON.parse(l)).find((e) => e.type === "FINALIZED");
    expect(finalized).toMatchObject({ type: "FINALIZED", outcome: "success", exitCode: 0 });
    client.destroy();
  });

  it("finalize writes supervisor + peer costs into final.md", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true, { costUsd: 1.25, tokens: 5000 }, undefined, PASS);
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content).toContain("total_cost_usd: 1.65");
    expect(content).toContain("total_tokens: 6200");
    expect(content).toContain("supervisor_cost_usd: 1.25");
    expect(content).toContain("supervisor_tokens: 5000");
    expect(content).toContain("- name: peer1");
    expect(content).toContain("cost_usd: 0.4");
    client.destroy();
  });

  it("finalize passing summary renders the summary section before Decision", async () => {
    const { dir, rt, client } = await run();
    await rt.finalize(true, { costUsd: 1.25, tokens: 5000 }, "decision text", PASS, {
      accomplished: ["did the thing"],
      left: ["nits"],
    });
    const content = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(content.indexOf("## Summary")).toBeGreaterThanOrEqual(0);
    expect(content.indexOf("## Summary")).toBeLessThan(content.indexOf("## Decision"));
    expect(content).toContain("**Total cost: $1.65** (peers $0.40, supervisor $1.25).");
    expect(content).toContain("**Accomplished:**");
    expect(content).toContain("- did the thing");
    expect(content).toContain("**Left:**");
    expect(content).toContain("- nits");
    client.destroy();
  });
});
