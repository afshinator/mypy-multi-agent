/**
 * Integration test: the Runtime composition layer over a real socket and a fake herdr.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";
import { peerToolLogPath } from "../../src/peer/peer-config";
import { Runtime } from "../../src/runtime/runtime";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p1",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};

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
      system_prompt: "sp",
    },
  ],
});

const tick = () => new Promise((r) => setTimeout(r, 50));

/** A minimal single-agent roster (peer1, edit/shell off). */
const onePeer = () => [
  {
    id: "peer1",
    title: "P1",
    model: "m/m",
    permissions: { read: true, edit: false, shell: false },
    max_cost_usd: 1,
    system_prompt: "sp",
  },
];

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

    const send = (env: unknown) => client.write(`${JSON.stringify(env)}\n`);

    send({
      id: "r1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId: "peer1",
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();
    expect(rt.registry.has("peer1")).toBe(true);

    send({
      id: "h1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "HEARTBEAT",
      payload: { agentId: "peer1" },
    });
    await tick();

    expect(
      rt.dispatch("peer1", {
        taskId: "t1",
        action: "a",
        contextFiles: [],
        constraints: [],
        localDoD: "d",
      }),
    ).toBe(true);
    await tick();
    expect(received.some((f) => f.includes('"type":"WORK_ORDER"'))).toBe(true);

    send({
      id: "f1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "FINAL_REPORT",
      payload: { agentId: "peer1", report: "done", usage: { cost: 0.5, tokens: 100 } },
    });
    await tick();
    expect(rt.reconciliation.hasReport("peer1")).toBe(true);
    expect(
      (rt.reconciliation.reports().get("peer1")!.payload as { usage: unknown }).usage,
    ).toMatchObject({ cost: 0.5, tokens: 100 });

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
    const send = (env: unknown) => client.write(`${JSON.stringify(env)}\n`);
    send({
      id: "r1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId: "peer1",
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();

    const base = { timestamp: 0, sender: "peer1", recipient: "supervisor" };
    send({ ...base, id: "p1", type: "PROMPT", payload: { agentId: "peer1", text: "hi" } });
    send({ ...base, id: "res1", type: "RESPONSE", payload: { agentId: "peer1", text: "ok" } });
    send({ ...base, id: "ack1", correlationId: "c1", type: "ACK", payload: { taskId: "t1" } });
    send({
      ...base,
      id: "im1",
      type: "INTENT_TO_MODIFY",
      payload: { agentId: "peer1", filePath: "x.ts", intent: "edit" },
    });
    send({
      ...base,
      id: "lk1",
      type: "LOCK_REQUEST",
      payload: { agentId: "peer1", filePath: "x.ts", lockId: "l1" },
    });
    send({
      ...base,
      id: "lk2",
      type: "LOCK_RELEASED",
      payload: { agentId: "peer1", filePath: "x.ts" },
    });
    // F1: an unparseable frame must be logged, not silently dropped (README contract).
    client.write("{not json\n");
    await tick();
    await rt.flush();

    expect(rt.states.get("peer1")).toBe("PENDING");
    expect(received.some((f) => f.includes('"type":"LOCK_ACQUIRED"'))).toBe(true);
    const entries = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8"))
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
    const send = (env: unknown) => client.write(`${JSON.stringify(env)}\n`);
    send({
      id: "r1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId: "peer1",
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();
    // Five malformed frames trip the breaker and destroy the registered socket;
    // the F2 frame that follows in the same chunk resolves to that destroyed
    // transport, so a lack of error handling here would crash the runtime.
    const f2 = {
      id: "f2",
      correlationId: "c",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "HEARTBEAT",
      payload: { nope: true },
    };
    client.write(`${"{bad\n".repeat(5) + JSON.stringify(f2)}\n`);
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
    const send = (env: unknown) => client.write(`${JSON.stringify(env)}\n`);
    send({
      id: "r1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId: "peer1",
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    send({
      id: "h1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "HEARTBEAT",
      payload: { agentId: "peer1" },
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(rt.states.get("peer1")).toBe("CRASHED");
    await rt.flush();
    const crash = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.type === "AGENT_CRASHED");
    expect(crash).toMatchObject({ payload: { agentId: "peer1", reason: "heartbeat timeout" } });
    client.destroy();
  });

  it("logs AGENT_CRASHED on peer disconnect", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
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
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();
    client.destroy();
    await tick();
    expect(rt.states.get("peer1")).toBe("CRASHED");
    await rt.flush();
    const crash = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.type === "AGENT_CRASHED");
    expect(crash).toMatchObject({ payload: { agentId: "peer1", reason: "disconnected" } });
  });

  it("a stop signal marks the peer STOPPED so a clean exit is not CRASHED", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
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
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();
    rt.controlPlane.stopAgent("peer1", "user");
    expect(rt.states.get("peer1")).toBe("STOPPED");
    client.destroy();
    await tick();
    expect(rt.states.get("peer1")).toBe("STOPPED");
    await rt.flush();
    const events = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "AGENT_CRASHED")).toBe(false);
  });

  it("heartbeat timeout does not overwrite a STOPPED peer", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 50 });
    await rt.start();
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
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    send({
      id: "h1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "HEARTBEAT",
      payload: { agentId: "peer1" },
    });
    // Wait for registration to be processed (a fixed tick flakes under parallel load).
    for (let i = 0; i < 100 && rt.states.get("peer1") === undefined; i++)
      await new Promise((r) => setTimeout(r, 10));
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
    const send = (env: unknown) => client.write(`${JSON.stringify(env)}\n`);
    send({
      id: "r1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId: "peer1",
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
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
    const cfg = JSON.parse(await readFile(join(dir, "run-details", ".peer-peer1.json"), "utf8"));
    expect(cfg).toMatchObject({
      agentId: "peer1",
      model: "m/m",
      systemPrompt: "sp",
      busPath: rt.bus.path,
      // issue #23: the peer's tool log must live in the run dir, not beside a
      // socket that may have been relocated to tmpdir.
      runDetailsDir: join(dir, "run-details"),
    });

    await rt.cleanup();
    expect(existsSync(join(dir, "run-details", ".peer-peer1.json"))).toBe(false);
  });

  it("keeps the peer tool log in run-details when the socket moves to tmpdir (issue #23)", async () => {
    // 80-char segment: the socket path exceeds the 100-char limit on any platform,
    // so resolveSocketPath relocates it out of the run directory.
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    const longDir = join(dir, "a".repeat(80));
    await mkdir(join(longDir, "run-details"), { recursive: true });
    rt = new Runtime(longDir, fakeHerdr, config);
    await rt.spawnPeers();
    const cfg = JSON.parse(
      await readFile(join(longDir, "run-details", ".peer-peer1.json"), "utf8"),
    );
    expect(rt.bus.path.startsWith(tmpdir())).toBe(true);
    expect(peerToolLogPath(cfg)).toBe(join(longDir, "run-details", "tool-calls.jsonl"));
    expect(existsSync(join(longDir, "run-details", ".peer-peer1.json"))).toBe(true);
    await rt.cleanup();
  });

  it("logs an ERROR entry when awaitResponse times out", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    await expect(rt.awaitResponse("peer1", 40)).rejects.toThrow("timed out");
    await rt.flush();
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).toContain("correlation-timeout");
    expect(log).toContain("peer1");
  });

  it("logs an ERROR entry when sendPrompt times out", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    await expect(rt.sendPrompt("supervisor", "peer1", "q", 40)).rejects.toThrow("timed out");
    await rt.flush();
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).toContain("correlation-timeout");
  });

  it("rejects a frame whose payload.agentId forges another agent", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
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
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();
    // sender matches the connection, but the payload claims another agent.
    send({
      id: "f1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "FINAL_REPORT",
      payload: { agentId: "peer2", report: "forged" },
    });
    await tick();
    await rt.flush();
    expect(rt.states.get("peer2")).toBeUndefined();
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).toContain("sender-mismatch");
    client.destroy();
  });

  it("rejects a frame whose sender does not match its connection", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
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
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();
    // A different sender id on the same connection must be dropped; destroying
    // the misbehaving connection then crashes its registered peer.
    send({
      id: "h1",
      timestamp: 0,
      sender: "peer2",
      recipient: "supervisor",
      type: "HEARTBEAT",
      payload: { agentId: "peer2" },
    });
    await tick();
    await rt.flush();
    expect(rt.states.get("peer1")).toBe("CRASHED");
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).toContain("sender-mismatch");
    client.destroy();
  });

  it("a reconnect re-registers cleanly and clears the stale crash", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const reg = {
      id: "r1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId: "peer1",
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    };
    const c1 = connect(rt.bus.path);
    await new Promise<void>((r) => c1.once("connect", () => r()));
    c1.write(`${JSON.stringify(reg)}\n`);
    await tick();
    c1.destroy(); // disconnect -> CRASHED + buffered AGENT_CRASHED
    await tick();
    expect(rt.states.get("peer1")).toBe("CRASHED");

    const c2 = connect(rt.bus.path);
    await new Promise<void>((r) => c2.once("connect", () => r()));
    c2.write(`${JSON.stringify(reg)}\n`); // re-register the same agent
    await tick();
    expect(rt.states.get("peer1")).toBe("PENDING");
    // The stale AGENT_CRASHED must not answer the next await early.
    await expect(rt.awaitResponse("peer1", 50)).rejects.toThrow("timed out");
    c2.destroy();
  });

  it("F1: a dispatched work order drops the peer's buffered previous report", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const c1 = connect(rt.bus.path);
    await new Promise<void>((r) => c1.once("connect", () => r()));
    c1.write(
      `${JSON.stringify({
        id: "reg-f1",
        timestamp: 0,
        sender: "peer1",
        recipient: "supervisor",
        type: "AGENT_REGISTER",
        payload: {
          agentId: "peer1",
          title: "P1",
          model: "m/m",
          permissions: { read: true, edit: false, shell: false },
          maxCostUsd: 1,
          systemPrompt: "sp",
        },
      })}\n`,
    );
    await tick();
    // The previous turn ends with nothing awaiting, so its report is buffered.
    c1.write(
      `${JSON.stringify({
        id: "fr-f1",
        timestamp: 0,
        sender: "peer1",
        recipient: "supervisor",
        type: "FINAL_REPORT",
        payload: { agentId: "peer1", report: "previous turn" },
      })}\n`,
    );
    await tick();
    expect(
      rt.dispatch("peer1", {
        taskId: "t2",
        action: "next",
        contextFiles: [],
        constraints: [],
        localDoD: "d",
      }),
    ).toBe(true);
    // The buffered report predates this work order and must not answer the await.
    await expect(rt.awaitResponse("peer1", 50)).rejects.toThrow("timed out");
    c1.destroy();
  });

  it("fails prompts to a STOPPED peer fast and logs peer-terminal", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const reg = {
      id: "r1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId: "peer1",
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    };
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg)}\n`);
    await tick();

    rt.controlPlane.stopAgent("peer1", "budget threshold");
    await tick();
    expect(rt.states.get("peer1")).toBe("STOPPED");

    const t0 = Date.now();
    await expect(rt.sendPrompt("supervisor", "peer1", "x", 60_000)).rejects.toMatchObject({
      name: "PeerTerminalError",
    });
    await expect(rt.awaitResponse("peer1", 60_000)).rejects.toMatchObject({
      name: "PeerTerminalError",
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
    await rt.flush();
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).toContain('"event":"peer-terminal"');
    expect(log).not.toContain('"event":"correlation-timeout"');
    client.destroy();
  });

  it("a STOPPED over-budget peer no longer masks another over-budget peer", async () => {
    const twoPeer = parseSessionConfig({
      version: "1.1",
      session: { id: "s2", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "peer1" },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: [
        {
          id: "peer1",
          title: "P1",
          model: "m/m",
          permissions: { read: true, edit: false, shell: false },
          max_cost_usd: 1,
          system_prompt: "sp",
        },
        {
          id: "peer2",
          title: "P2",
          model: "m/m",
          permissions: { read: true, edit: false, shell: false },
          max_cost_usd: 1,
          system_prompt: "sp",
        },
      ],
    });
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, twoPeer);
    await rt.start();
    // One socket per agent: AgentRegistry rejects a second id on one connection.
    const c1 = connect(rt.bus.path);
    const c2 = connect(rt.bus.path);
    const received: string[] = [];
    c2.on("data", (d) => received.push(d.toString()));
    await new Promise<void>((r) => c1.once("connect", () => r()));
    await new Promise<void>((r) => c2.once("connect", () => r()));
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
    c1.write(`${JSON.stringify(reg("peer1"))}\n`);
    c2.write(`${JSON.stringify(reg("peer2"))}\n`);
    await tick();
    expect(rt.registry.has("peer1")).toBe(true);
    expect(rt.registry.has("peer2")).toBe(true);

    rt.controlPlane.stopAgent("peer1", "budget threshold");
    rt.accounting.recordUsage({ agentId: "peer1", cost: 0.9, tokens: 0 });
    rt.accounting.recordUsage({ agentId: "peer2", cost: 0.9, tokens: 0 });
    // peer2 sends a response; enforceBudget must skip the STOPPED peer1 and stop peer2.
    c2.write(
      `${JSON.stringify({ id: "resp1", timestamp: 0, sender: "peer2", recipient: "supervisor", type: "RESPONSE", payload: { agentId: "peer2", text: "ok" } })}\n`,
    );
    await tick();
    expect(
      received.some((f) => f.includes('"type":"STOP_AGENT"') && f.includes('"recipient":"peer2"')),
    ).toBe(true);
    c1.destroy();
    c2.destroy();
  });

  it("AGENT_UNUSABLE marks the peer terminal, stops it, is logged, and wakes an await", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const received: string[] = [];
    const client = connect(rt.bus.path);
    client.on("data", (d) => received.push(d.toString()));
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
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();
    const waiter = rt.awaitResponse("supervisor", 2000);
    send({
      id: "u1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "AGENT_UNUSABLE",
      payload: { agentId: "peer1", reason: "empty model output", attempts: 4 },
    });
    await tick();
    await rt.flush();
    expect(rt.states.get("peer1")).toBe("CRASHED");
    expect(await waiter).toMatchObject({ type: "AGENT_UNUSABLE" });
    expect(
      received.some((f) => f.includes('"type":"STOP_AGENT"') && f.includes('"recipient":"peer1"')),
    ).toBe(true);
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).toContain('"type":"AGENT_UNUSABLE"');
    client.destroy();
  });

  it("without stop_at_work_order_boundary a threshold crossing stops the peer immediately", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const received: string[] = [];
    const client = connect(rt.bus.path);
    client.on("data", (d) => received.push(d.toString()));
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
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();
    send({
      id: "resp1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "RESPONSE",
      payload: { agentId: "peer1", text: "working", usage: { cost: 0.9, tokens: 0 } },
    });
    await vi.waitFor(() => expect(rt!.states.get("peer1")).toBe("STOPPED"), { timeout: 3000 });
    client.destroy();
  });

  it("stop_at_work_order_boundary defers a threshold stop to the work-order boundary", async () => {
    const boundaryCfg = parseSessionConfig({
      version: "1.1",
      session: {
        id: "b1",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        stop_at_work_order_boundary: true,
        attester: "peer1",
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
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
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, boundaryCfg);
    await rt.start();
    const received: string[] = [];
    const client = connect(rt.bus.path);
    client.on("data", (d) => received.push(d.toString()));
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
        title: "P1",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        maxCostUsd: 1,
        systemPrompt: "sp",
      },
    });
    await tick();
    // A mid-work reply crossing the threshold must not stop the peer yet.
    send({
      id: "resp1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "RESPONSE",
      payload: { agentId: "peer1", text: "still working", usage: { cost: 0.9, tokens: 0 } },
    });
    // Wait until the RESPONSE is accounted for, then assert the stop was deferred
    // (a fixed tick flakes under parallel load).
    await vi.waitFor(
      () => expect(rt!.accounting.getAgentCost("peer1")).toBeGreaterThanOrEqual(0.9),
      {
        timeout: 3000,
      },
    );
    expect(rt.states.get("peer1")).not.toBe("STOPPED");
    expect(received.some((f) => f.includes('"type":"STOP_AGENT"'))).toBe(false);
    // Completing the work order stops it.
    send({
      id: "f1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "FINAL_REPORT",
      payload: { agentId: "peer1", report: "done", usage: { cost: 0.1, tokens: 0 } },
    });
    await vi.waitFor(() => expect(rt!.states.get("peer1")).toBe("STOPPED"), { timeout: 3000 });
    expect(received.some((f) => f.includes('"type":"STOP_AGENT"'))).toBe(true);
    client.destroy();
  });

  it("restartAgent rewrites the peer config with the new model and respawns in place", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    const commands: string[] = [];
    const herdr: HerdrClient = {
      createPane: async () => "p1",
      runCommand: async (pane, cmd) => void commands.push(`${pane}:${cmd}`),
      reportMetadata: async () => {},
      closePane: async () => {},
    };
    rt = new Runtime(dir, herdr, config, { peerScript: "/abs/peer-main.ts" });
    await rt.spawnPeers();
    const before = commands.length;
    expect(await rt.restartAgent("peer1", "provider/other")).toBe(true);
    expect(commands.length).toBe(before + 1);
    expect(commands[before]).toContain("--config");
    const cfg = JSON.parse(await readFile(join(dir, "run-details", ".peer-peer1.json"), "utf8"));
    expect(cfg.model).toBe("provider/other");
    expect(rt.states.get("peer1")).toBe("PENDING");
    expect(await rt.restartAgent("ghost")).toBe(false);
  });

  it("restartAgent evicts the old connection so the fresh peer can re-register", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
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
    const c1 = connect(rt.bus.path);
    await new Promise<void>((r) => c1.once("connect", () => r()));
    c1.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    expect(rt.registry.has("peer1")).toBe(true);

    await rt.restartAgent("peer1", "provider/other");
    const c2 = connect(rt.bus.path);
    await new Promise<void>((r) => c2.once("connect", () => r()));
    c2.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    await rt.flush();
    expect(rt.registry.has("peer1")).toBe(true);
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).not.toContain("envelope-handler-threw");
    c1.destroy();
    c2.destroy();
  });

  it("boundary mode still trips the global ceiling (a deferred agent must not mask it)", async () => {
    const cfg = parseSessionConfig({
      version: "1.1",
      session: {
        id: "g1",
        max_cost_usd: 1,
        agent_stop_threshold_percent: 85,
        stop_at_work_order_boundary: true,
        attester: "peer1",
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: onePeer(),
    });
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, cfg);
    await rt.start();
    const received: string[] = [];
    const client = connect(rt.bus.path);
    client.on("data", (d) => received.push(d.toString()));
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    // 1.1 against a 1.0 global ceiling trips the agent bound and the ceiling.
    client.write(
      `${JSON.stringify({ id: "resp1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "RESPONSE", payload: { agentId: "peer1", text: "x", usage: { cost: 1.1, tokens: 0 } } })}\n`,
    );
    await tick();
    expect(received.some((f) => f.includes('"type":"STOP_ALL"'))).toBe(true);
    client.destroy();
  });

  it("boundary mode does not let a deferred agent mask a second over-budget peer", async () => {
    const cfg = parseSessionConfig({
      version: "1.1",
      session: {
        id: "m1",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        stop_at_work_order_boundary: true,
        attester: "peer1",
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: [onePeer()[0]!, { ...onePeer()[0]!, id: "peer2", title: "P2" }],
    });
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, cfg);
    await rt.start();
    const c1 = connect(rt.bus.path);
    const c2 = connect(rt.bus.path);
    await new Promise<void>((r) => c1.once("connect", () => r()));
    await new Promise<void>((r) => c2.once("connect", () => r()));
    c1.write(`${JSON.stringify(reg("peer1"))}\n`);
    c2.write(`${JSON.stringify(reg("peer2"))}\n`);
    await tick();
    const resp = (id: string) =>
      `${JSON.stringify({ id: `resp-${id}`, timestamp: 0, sender: id, recipient: "supervisor", type: "RESPONSE", payload: { agentId: id, text: "x", usage: { cost: 0.9, tokens: 0 } } })}\n`;
    const report = (id: string) =>
      `${JSON.stringify({ id: `fin-${id}`, timestamp: 0, sender: id, recipient: "supervisor", type: "FINAL_REPORT", payload: { agentId: id, report: "done", usage: { cost: 0.1, tokens: 0 } } })}\n`;
    c1.write(resp("peer1"));
    c2.write(resp("peer2"));
    await tick();
    c1.write(report("peer1"));
    await tick();
    expect(rt.states.get("peer1")).toBe("STOPPED");
    c2.write(report("peer2"));
    await tick();
    expect(rt.states.get("peer2")).toBe("STOPPED");
    c1.destroy();
    c2.destroy();
  });

  it("restartAgent releases locks the old peer held", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const c1 = connect(rt.bus.path);
    const c1received: string[] = [];
    c1.on("data", (d) => c1received.push(d.toString()));
    await new Promise<void>((r) => c1.once("connect", () => r()));
    c1.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    const lock = (id: string) =>
      `${JSON.stringify({ id: `lk-${id}`, timestamp: 0, sender: id, recipient: "supervisor", type: "LOCK_REQUEST", payload: { agentId: id, filePath: "src/x.ts", lockId: `l-${id}` } })}\n`;
    c1.write(lock("peer1"));
    await tick();
    expect(c1received.some((f) => f.includes('"type":"LOCK_ACQUIRED"'))).toBe(true);

    await rt.restartAgent("peer1");
    const c2 = connect(rt.bus.path);
    const c2received: string[] = [];
    c2.on("data", (d) => c2received.push(d.toString()));
    await new Promise<void>((r) => c2.once("connect", () => r()));
    c2.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    // Without releaseAll the lock survives the restart and this is denied forever.
    c2.write(lock("peer1"));
    await tick();
    expect(c2received.some((f) => f.includes('"type":"LOCK_ACQUIRED"'))).toBe(true);
    c1.destroy();
    c2.destroy();
  });

  it("restartAgent fails an in-flight send_prompt instead of hanging", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    const pending = rt.sendPrompt("supervisor", "peer1", "q", 60_000);
    await rt.restartAgent("peer1");
    await expect(pending).rejects.toMatchObject({ name: "PeerTerminalError" });
    client.destroy();
  });

  it("emits AGENT_STALLED for a busy peer making no progress and wakes the await", async () => {
    const stallCfg = parseSessionConfig({
      version: "1.1",
      session: {
        id: "st1",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        stall_timeout_ms: 50,
        attester: "peer1",
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: onePeer(),
    });
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, stallCfg, {
      heartbeatIntervalMs: 15,
      heartbeatTimeoutMs: 60_000,
    });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    const waiter = rt.awaitResponse("peer1", 5000);
    client.write(
      `${JSON.stringify({ id: "hb1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1", busy: true, progressed: true } })}\n`,
    );
    const env = await waiter;
    expect(env).toMatchObject({ type: "AGENT_STALLED", payload: { agentId: "peer1" } });
    // Notify-only: the peer is not stopped or marked crashed.
    expect(rt.states.get("peer1")).toBe("PENDING");
    client.destroy();
  });

  it("F2: a peer that only reports retries is flagged stalled and the retry is logged", async () => {
    const stallCfg = parseSessionConfig({
      version: "1.1",
      session: {
        id: "retry1",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        stall_timeout_ms: 50,
        attester: "peer1",
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: onePeer(),
    });
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, stallCfg, {
      heartbeatIntervalMs: 15,
      heartbeatTimeoutMs: 60_000,
    });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    const waiter = rt.awaitResponse("peer1", 5000);
    // The F2 scenario: a turn stuck in a retry loop reports retry activity and no
    // progress. Before the fix these beats were `progressed: true`, so the stall
    // clock reset forever and the supervisor blocked to its own timeout.
    for (let attempt = 1; attempt <= 3; attempt++) {
      client.write(
        `${JSON.stringify({ id: `hb${attempt}`, timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1", busy: true, progressed: false, retry: { attempt, maxAttempts: 3 } } })}\n`,
      );
      await tick();
    }
    const env = await waiter;
    expect(env).toMatchObject({ type: "AGENT_STALLED", payload: { agentId: "peer1" } });
    await rt.flush();
    const lines = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "RETRY");
    // One entry per attempt change, not one per beat.
    expect(lines.map((e) => e.attempt)).toEqual([1, 2, 3]);
    client.destroy();
  });

  it("a peer that keeps reporting progress is not flagged stalled", async () => {
    const stallCfg = parseSessionConfig({
      version: "1.1",
      session: {
        id: "st2",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        stall_timeout_ms: 200,
        attester: "peer1",
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: onePeer(),
    });
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, stallCfg, {
      heartbeatIntervalMs: 15,
      heartbeatTimeoutMs: 60_000,
    });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    for (let i = 0; i < 6; i++) {
      client.write(
        `${JSON.stringify({ id: `hb-${i}`, timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1", busy: true, progressed: true } })}\n`,
      );
      await new Promise((r) => setTimeout(r, 40));
    }
    await rt.flush();
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).not.toContain("AGENT_STALLED");
    client.destroy();
  });

  it("a turn that ends (busy:false) is cleared and not flagged stalled", async () => {
    const stallCfg = parseSessionConfig({
      version: "1.1",
      session: {
        id: "st3",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        stall_timeout_ms: 60,
        attester: "peer1",
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: onePeer(),
    });
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, stallCfg, {
      heartbeatIntervalMs: 15,
      heartbeatTimeoutMs: 60_000,
    });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    client.write(
      `${JSON.stringify({ id: "hb1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1", busy: true, progressed: true } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 20));
    client.write(
      `${JSON.stringify({ id: "hb2", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1", busy: false } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 200));
    await rt.flush();
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).not.toContain("AGENT_STALLED");
    client.destroy();
  });

  it("stall_timeout_ms 0 disables stall detection", async () => {
    const stallCfg = parseSessionConfig({
      version: "1.1",
      session: {
        id: "st4",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        stall_timeout_ms: 0,
        attester: "peer1",
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: onePeer(),
    });
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, stallCfg, {
      heartbeatIntervalMs: 15,
      heartbeatTimeoutMs: 60_000,
    });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    client.write(
      `${JSON.stringify({ id: "hb1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1", busy: true, progressed: true } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 200));
    await rt.flush();
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).not.toContain("AGENT_STALLED");
    client.destroy();
  });

  it("does not flag a STOPPED peer that sends a late busy heartbeat", async () => {
    const stallCfg = parseSessionConfig({
      version: "1.1",
      session: {
        id: "st5",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        stall_timeout_ms: 50,
        attester: "peer1",
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: onePeer(),
    });
    dir = await mkdtemp(join(tmpdir(), "rt-"));
    rt = new Runtime(dir, fakeHerdr, stallCfg, {
      heartbeatIntervalMs: 15,
      heartbeatTimeoutMs: 60_000,
    });
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(reg("peer1"))}\n`);
    await tick();
    rt.controlPlane.stopAgent("peer1", "user");
    // The peer's heartbeat interval may fire once more before it exits; a
    // terminal peer must not re-arm the stall scan.
    client.write(
      `${JSON.stringify({ id: "hb1", timestamp: 0, sender: "peer1", recipient: "supervisor", type: "HEARTBEAT", payload: { agentId: "peer1", busy: true, progressed: true } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 150));
    await rt.flush();
    const log = await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8");
    expect(log).not.toContain("AGENT_STALLED");
    client.destroy();
  });
});
