/**
 * Integration test: the Runtime composition layer over a real socket and a fake herdr.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { Runtime } from "../../src/runtime/runtime";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p1",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};

const config = parseSessionConfig({
  version: "1.1",
  session: { id: "s1", max_cost_usd: 5, agent_stop_threshold_percent: 85 },
  ask: { title: "t", description: "d", definition_of_done: "dod" },
  agents: [
    {
      id: "peer1",
      title: "P1",
      model: "m/m",
      permissions: { read: true, edit: false, shell: false },
      max_cost_usd: 1,
      system_prompt: "sp",
    },
  ],
});

const tick = () => new Promise((r) => setTimeout(r, 50));

describe("Runtime", () => {
  let dir: string | undefined;
  let rt: Runtime | undefined;

  afterEach(async () => {
    await rt?.stop().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("registers a peer, receives a work order, captures its report", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    expect(existsSync(rt.bus.path)).toBe(true);

    const received: string[] = [];
    const client = connect(rt.bus.path);
    client.on("data", (d) => received.push(d.toString()));
    await new Promise<void>((r) => client.once("connect", () => r()));

    const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");

    send({
      id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: { agentId: "peer1", title: "P1", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" },
    });
    await tick();
    expect(rt.registry.has("peer1")).toBe(true);

    send({ id: "h1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1" } });
    await tick();

    expect(rt.dispatch("peer1", { taskId: "t1", action: "a", contextFiles: [], constraints: [], localDoD: "d" })).toBe(true);
    await tick();
    expect(received.some((f) => f.includes('"type":"WORK_ORDER"'))).toBe(true);

    send({ id: "f1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "FINAL_REPORT", payload: { agentId: "peer1", report: "done", usage: { cost: 0.5, tokens: 100 } } });
    await tick();
    expect(rt.reconciliation.hasReport("peer1")).toBe(true);
    expect((rt.reconciliation.reports().get("peer1")!.payload as { usage: unknown }).usage).toMatchObject({ cost: 0.5, tokens: 100 });

    client.destroy();
  });

  it("handles every remaining inbound type and logs f1 frames", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const received: string[] = [];
    const client = connect(rt.bus.path);
    client.on("data", (d) => received.push(d.toString()));
    await new Promise<void>((r) => client.once("connect", () => r()));
    const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
    send({
      id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: { agentId: "peer1", title: "P1", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" },
    });
    await tick();

    const base = { timestamp: 0, sender: "peer1", recipient: "supervisor" };
    send({ ...base, id: "p1", type: "PROMPT", payload: { agentId: "peer1", text: "hi" } });
    send({ ...base, id: "res1", type: "RESPONSE", payload: { agentId: "peer1", text: "ok" } });
    send({ ...base, id: "ack1", correlationId: "c1", type: "ACK", payload: { taskId: "t1" } });
    send({ ...base, id: "im1", type: "INTENT_TO_MODIFY", payload: { agentId: "peer1", filePath: "x.ts", intent: "edit" } });
    send({ ...base, id: "lk1", type: "LOCK_REQUEST", payload: { agentId: "peer1", filePath: "x.ts", lockId: "l1" } });
    send({ ...base, id: "lk2", type: "LOCK_RELEASED", payload: { agentId: "peer1", filePath: "x.ts" } });
    // F1: an unparseable frame must be logged, not silently dropped (README contract).
    client.write("{not json\n");
    await tick();
    await rt.flush();

    expect(rt.states.get("peer1")).toBe("PENDING");
    expect(received.some((f) => f.includes('"type":"LOCK_ACQUIRED"'))).toBe(true);
    const entries = (await readFile(join(dir, "conversation.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries.some((e) => e.type === "ERROR" && e.event === "f1")).toBe(true);
    client.destroy();
  });

  it("contains a flooding socket without writing to the destroyed transport", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
    send({
      id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: { agentId: "peer1", title: "P1", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" },
    });
    await tick();
    // Five malformed frames trip the breaker and destroy the registered socket;
    // the F2 frame that follows in the same chunk resolves to that destroyed
    // transport, so a lack of error handling here would crash the runtime.
    const f2 = { id: "f2", correlationId: "c", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { nope: true } };
    client.write("{bad\n".repeat(5) + JSON.stringify(f2) + "\n");
    await tick();
    await rt.flush();
    expect(rt.states.get("peer1")).toBe("STOPPED");
    client.destroy();
  });

  it("marks a silent peer CRASHED at the heartbeat deadline", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config, { heartbeatIntervalMs: 20, heartbeatTimeoutMs: 100 });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
    send({ id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId: "peer1", title: "P1", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
    send({ id: "h1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1" } });
    await new Promise((r) => setTimeout(r, 250));
    expect(rt.states.get("peer1")).toBe("CRASHED");
    await rt.flush();
    const crash = (await readFile(join(dir, "conversation.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "AGENT_CRASHED");
    expect(crash).toMatchObject({ payload: { agentId: "peer1", reason: "heartbeat timeout" } });
    client.destroy();
  });

  it("logs AGENT_CRASHED on peer disconnect", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
    send({ id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId: "peer1", title: "P1", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
    await tick();
    client.destroy();
    await tick();
    expect(rt.states.get("peer1")).toBe("CRASHED");
    await rt.flush();
    const crash = (await readFile(join(dir, "conversation.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "AGENT_CRASHED");
    expect(crash).toMatchObject({ payload: { agentId: "peer1", reason: "disconnected" } });
  });

  it("a stop signal marks the peer STOPPED so a clean exit is not CRASHED", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
    send({ id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId: "peer1", title: "P1", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
    await tick();
    rt.controlPlane.stopAgent("peer1", "user");
    expect(rt.states.get("peer1")).toBe("STOPPED");
    client.destroy();
    await tick();
    expect(rt.states.get("peer1")).toBe("STOPPED");
    await rt.flush();
    const events = (await readFile(join(dir, "conversation.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "AGENT_CRASHED")).toBe(false);
  });

  it("heartbeat timeout does not overwrite a STOPPED peer", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 50 });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
    send({ id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId: "peer1", title: "P1", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
    send({ id: "h1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1" } });
    // Wait for registration to be processed (a fixed tick flakes under parallel load).
    for (let i = 0; i < 100 && rt.states.get("peer1") === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    rt.controlPlane.stopAgent("peer1", "user");
    expect(rt.states.get("peer1")).toBe("STOPPED");
    // Let the heartbeat monitor fire several times: it must not flip STOPPED to CRASHED.
    await new Promise((r) => setTimeout(r, 200));
    expect(rt.states.get("peer1")).toBe("STOPPED");
    client.destroy();
  });

  it("5 malformed frames trigger a supervisor-directed stop", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const received: string[] = [];
    const client = connect(rt.bus.path);
    client.on("data", (d) => received.push(d.toString()));
    await new Promise<void>((r) => client.once("connect", () => r()));
    const send = (env: unknown) => client.write(JSON.stringify(env) + "\n");
    send({ id: "r1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "AGENT_REGISTER", payload: { agentId: "peer1", title: "P1", model: "m/m", permissions: { read: true, edit: false, shell: false }, maxCostUsd: 1, systemPrompt: "sp" } });
    await tick();
    for (let i = 0; i < 5; i++) client.write("{bad json\n");
    await tick();
    expect(received.some((f) => f.includes("STOP_AGENT"))).toBe(true);
    client.destroy();
  });

  it("spawnPeers writes per-peer config and spawns with --config", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    const commands: string[] = [];
    const herdr: HerdrClient = {
      createPane: async () => "p1",
      runCommand: async (_pane, cmd) => void commands.push(cmd),
      reportMetadata: async () => {},
      closePane: async () => {},
    };
    rt = new Runtime(dir, herdr, config);
    await rt.spawnPeers();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--config");
    const cfg = JSON.parse(await readFile(join(dir, ".peer-peer1.json"), "utf8"));
    expect(cfg).toMatchObject({ agentId: "peer1", model: "m/m", systemPrompt: "sp", busPath: rt.bus.path });

    await rt.cleanup();
    expect(existsSync(join(dir, ".peer-peer1.json"))).toBe(false);
  });
});
