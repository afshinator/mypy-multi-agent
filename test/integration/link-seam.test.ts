/**
 * The transport seam is real (#168): Runtime accepts a PeerLink, so lifecycle
 * behaviour can be driven frame by frame with no unix socket, and observed
 * through the narrowed accessors rather than raw fields.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PeerConnection, PeerLink } from "../../src/bus/peer-link";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";
import { Runtime } from "../../src/runtime/runtime";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** An in-memory transport: the second adapter that makes PeerLink a seam. */
class FakeLink implements PeerLink {
  readonly sent: { agentId: string | null; line: string }[] = [];
  private readonly byAgent = new Map<string, PeerConnection>();
  private accept?: (connection: PeerConnection) => void;

  async start(onConnection: (connection: PeerConnection) => void): Promise<void> {
    this.accept = onConnection;
  }

  async stop(): Promise<void> {
    this.byAgent.clear();
  }

  /** A peer connection the runtime accepts, with a handle the test writes through. */
  connect(): { send: (env: unknown) => void } {
    const listeners: ((chunk: string) => void)[] = [];
    const connection: PeerConnection = {
      destroyed: false,
      write: (line) => {
        const parsed = JSON.parse(line) as { recipient?: string };
        this.sent.push({ agentId: parsed.recipient ?? null, line });
      },
      destroy: () => {},
      onConnect: () => {},
      onData: (listener) => {
        listeners.push(listener);
      },
      onClose: () => {},
      onError: () => {},
    };
    this.accept?.(connection);
    return {
      send: (env) => {
        for (const listener of listeners) listener(`${JSON.stringify(env)}\n`);
      },
    };
  }

  register(agentId: string, connection: PeerConnection): void {
    this.byAgent.set(agentId, connection);
  }
  unregister(agentId: string): void {
    this.byAgent.delete(agentId);
  }
  has(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }
  send(agentId: string, line: string): void {
    // Recorded by the connection's write, so one frame is never counted twice.
    const connection = this.byAgent.get(agentId);
    if (connection === undefined) this.sent.push({ agentId, line });
    else connection.write(line);
  }
  sendAll(line: string): void {
    for (const agentId of this.byAgent.keys()) this.send(agentId, line);
  }
  destroy(agentId: string): void {
    this.byAgent.delete(agentId);
  }
}

const config = (agentMaxCost: number) =>
  parseSessionConfig({
    version: "1.1",
    session: {
      id: "s",
      max_cost_usd: 100,
      agent_stop_threshold_percent: 85,
      attester: "peer1",
      stop_at_work_order_boundary: true,
    },
    ask: { title: "t", description: "d", definition_of_done: ["dod"] },
    agents: [
      {
        id: "peer1",
        title: "P",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: agentMaxCost,
        system_prompt: "sp",
      },
    ],
  });

const register = (agentId: string) => ({
  id: "reg",
  timestamp: 0,
  sender: agentId,
  recipient: "supervisor",
  type: "AGENT_REGISTER",
  payload: {
    agentId,
    title: "P",
    model: "m/m",
    permissions: { read: true, edit: false, shell: false },
    maxCostUsd: 1,
    systemPrompt: "sp",
  },
});

const tick = () => new Promise<void>((r) => setTimeout(r, 20));

async function runtime(agentMaxCost = 1) {
  const dir = await mkdtemp(join(tmpdir(), "rt-link-"));
  dirs.push(dir);
  const link = new FakeLink();
  const rt = new Runtime(dir, fakeHerdr, config(agentMaxCost), {
    link,
    heartbeatTimeoutMs: 60_000,
  });
  await rt.start();
  return { rt, link, dir };
}

describe("an injected PeerLink", () => {
  it("opens no socket", async () => {
    const { rt, link } = await runtime();
    link.connect();
    await tick();
    expect(existsSync(rt.bus.path)).toBe(false);
  });

  it("stops an over-threshold peer at its work-order boundary, seen through accessors", async () => {
    const { rt, link } = await runtime(0.1);
    const peer = link.connect();
    peer.send(register("peer1"));
    await tick();

    peer.send({
      id: "hb",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "HEARTBEAT",
      payload: { agentId: "peer1", busy: true, progressed: true },
    });
    await tick();
    expect(rt.peerStatuses()[0]).toMatchObject({ agentId: "peer1", busy: true, stalled: false });

    peer.send({
      id: "f1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "FINAL_REPORT",
      payload: { agentId: "peer1", report: "done", usage: { cost: 0.5, tokens: 100 } },
    });
    await tick();

    // Spend and state through the accessors, never rt.accounting / rt.states.
    expect(rt.agentSpend("peer1")).toEqual({ costUsd: 0.5, tokens: 100 });
    expect(rt.agentState("peer1")).toBe("STOPPED");

    const stopped = link.sent
      .map((s) => JSON.parse(s.line) as { type: string; payload?: { agentId?: string } })
      .filter((env) => env.type === "STOP_AGENT");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.payload?.agentId).toBe("peer1");
  });
});
