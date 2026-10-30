/**
 * Integration test: locks across the wired runtime.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
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

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const config = parseSessionConfig({
  version: "1.1",
  session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "a1" },
  ask: { title: "t", description: "d", definition_of_done: ["dod"] },
  agents: [
    {
      id: "a1",
      title: "A",
      model: "m/m",
      permissions: { read: true, edit: true, shell: false },
      max_cost_usd: 1,
      system_prompt: "sp",
    },
    {
      id: "b1",
      title: "B",
      model: "m/m",
      permissions: { read: true, edit: true, shell: false },
      max_cost_usd: 1,
      system_prompt: "sp",
    },
  ],
});

// Issue #133: a short acquire bound, so a lost race is refused fast instead of
// after the fixed 30 s.
const shortLockConfig = parseSessionConfig({
  version: "1.1",
  session: {
    id: "s",
    max_cost_usd: 5,
    agent_stop_threshold_percent: 85,
    lock_acquire_timeout_ms: 100,
    attester: "a1",
  },
  ask: { title: "t", description: "d", definition_of_done: ["dod"] },
  agents: [
    {
      id: "a1",
      title: "A",
      model: "m/m",
      permissions: { read: true, edit: true, shell: false },
      max_cost_usd: 1,
      system_prompt: "sp",
    },
    {
      id: "b1",
      title: "B",
      model: "m/m",
      permissions: { read: true, edit: true, shell: false },
      max_cost_usd: 1,
      system_prompt: "sp",
    },
  ],
});

async function connectPeer(rt: Runtime, agentId: string) {
  const received: string[] = [];
  const client: Socket = connect(rt.bus.path);
  client.on("data", (d) => received.push(d.toString()));
  await new Promise<void>((r) => client.once("connect", () => r()));
  const send = (env: unknown) => client.write(`${JSON.stringify(env)}\n`);
  send({
    id: `r-${agentId}`,
    timestamp: 0,
    sender: agentId,
    recipient: "supervisor",
    type: "AGENT_REGISTER",
    payload: {
      agentId,
      title: agentId,
      model: "m/m",
      permissions: { read: true, edit: true, shell: false },
      maxCostUsd: 1,
      systemPrompt: "sp",
    },
  });
  await tick();
  return { client, received, send };
}

const lockRequest = (agentId: string, filePath: string, lockId: string) => ({
  id: `lr-${lockId}`,
  timestamp: 0,
  sender: agentId,
  recipient: "supervisor",
  type: "LOCK_REQUEST",
  payload: { agentId, filePath, lockId },
});
const lockRelease = (agentId: string, filePath: string) => ({
  id: `rel-${filePath}`,
  timestamp: 0,
  sender: agentId,
  recipient: "supervisor",
  type: "LOCK_RELEASED",
  payload: { agentId, filePath },
});

describe("distributed file locks", () => {
  it("LOCK_REQUEST grants LOCK_ACQUIRED to the requesting peer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const a = await connectPeer(rt, "a1");
    a.send(lockRequest("a1", "f.txt", "l1"));
    await tick();
    expect(a.received.some((f) => f.includes("LOCK_ACQUIRED"))).toBe(true);
    a.client.destroy();
  });

  it("two peers contend FIFO on the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const a = await connectPeer(rt, "a1");
    const b = await connectPeer(rt, "b1");
    a.send(lockRequest("a1", "f.txt", "l1"));
    await tick();
    expect(a.received.some((f) => f.includes("LOCK_ACQUIRED"))).toBe(true);
    b.send(lockRequest("b1", "f.txt", "l2"));
    await tick();
    expect(b.received.some((f) => f.includes("LOCK_ACQUIRED"))).toBe(false);
    a.send(lockRelease("a1", "f.txt"));
    await tick();
    expect(b.received.some((f) => f.includes("LOCK_ACQUIRED"))).toBe(true);
    a.client.destroy();
    b.client.destroy();
  });

  it("writes lock frames to lock-frames.jsonl, not conversation.jsonl (issue #133)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const a = await connectPeer(rt, "a1");
    a.send(lockRequest("a1", "f.txt", "l1"));
    await tick();
    expect(a.received.some((f) => f.includes("LOCK_ACQUIRED"))).toBe(true);
    a.send(lockRelease("a1", "f.txt"));
    await tick();
    await rt.flush();
    const convTypes = (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).type);
    for (const type of ["LOCK_REQUEST", "LOCK_ACQUIRED", "LOCK_RELEASED", "LOCK_REFUSED"])
      expect(convTypes, type).not.toContain(type);
    const lockFrames = (await readFile(join(dir, "run-details", "lock-frames.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lockFrames.length).toBeGreaterThan(0);
    expect(lockFrames.some((l) => JSON.parse(l).type === "LOCK_REQUEST")).toBe(true);
    a.client.destroy();
  });

  it("refuses a losing lock request at the session bound, carrying its lock id (issue #133)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, shortLockConfig);
    await rt.start();
    const a = await connectPeer(rt, "a1");
    const b = await connectPeer(rt, "b1");
    a.send(lockRequest("a1", "f.txt", "l1"));
    await tick();
    expect(a.received.some((f) => f.includes("LOCK_ACQUIRED"))).toBe(true);
    const t0 = Date.now();
    b.send(lockRequest("b1", "f.txt", "l2"));
    const deadline = Date.now() + 30_000;
    while (!b.received.some((f) => f.includes("LOCK_REFUSED")) && Date.now() < deadline) {
      await tick();
    }
    const line = b.received.flatMap((c) => c.split("\n")).find((l) => l.includes("LOCK_REFUSED"));
    expect(line, "no LOCK_REFUSED reached b1").toBeDefined();
    const frame = JSON.parse(line!);
    expect(frame.type).toBe("LOCK_REFUSED");
    expect(frame.payload.lockId).toBe("l2");
    // At the 100 ms bound, not after the old fixed 30 s default.
    expect(Date.now() - t0).toBeLessThan(5_000);
    a.client.destroy();
    b.client.destroy();
  });

  it("disconnect releases the peer's lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-"));
    dirs.push(dir);
    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    const a = await connectPeer(rt, "a1");
    const b = await connectPeer(rt, "b1");
    a.send(lockRequest("a1", "f.txt", "l1"));
    await tick();
    expect(a.received.some((f) => f.includes("LOCK_ACQUIRED"))).toBe(true);
    a.client.destroy();
    await tick();
    b.send(lockRequest("b1", "f.txt", "l2"));
    await tick();
    expect(b.received.some((f) => f.includes("LOCK_ACQUIRED"))).toBe(true);
    b.client.destroy();
  });
});
