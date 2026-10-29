/**
 * Issue #134: per-model-class stall deadline and the first-tool-call probe.
 * Runtime wiring over a real socket with a fake peer (the integration-test
 * pattern), plus the no-free-class regression pin over the shipped template
 * manifest, and the stall-signal pin: tool-call activity, never a silent
 * reply, is what keeps a peer out of the stalled state.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";
import { stallTimeoutForAgent } from "../../src/peer/peer-config";
import { PeerSession } from "../../src/peer/peer-session";
import { writerRoleNeedsProbe } from "../../src/runtime/first-tool-call-probe";
import { Runtime } from "../../src/runtime/runtime";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p1",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};

const isFree = (m: string) => m === "free/x";

/** One priced writer and one free-class writer, so each class is exercised. */
const roster = () => [
  {
    id: "paid1",
    title: "P",
    model: "paid/m",
    permissions: { read: true, edit: true, shell: false },
    max_cost_usd: 1,
    system_prompt: "sp",
  },
  {
    id: "free1",
    title: "F",
    model: "free/x",
    permissions: { read: true, edit: true, shell: false },
    max_cost_usd: 1,
    max_tokens: 1000,
    system_prompt: "sp",
  },
];

const manifest = (session: Record<string, unknown> = {}) =>
  parseSessionConfig(
    {
      version: "1.1",
      session: {
        id: "s1",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        attester: "paid1",
        ...session,
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: roster(),
    },
    isFree,
  );

const tick = () => new Promise((r) => setTimeout(r, 50));

/** One bus frame as the fake peer sees it. */
type Frame = { type?: string; correlationId?: string };

const order = (taskId: string) => ({
  taskId,
  action: "do it",
  contextFiles: [],
  constraints: [],
  localDoD: "d",
  writeScope: ["src/a.ts"],
});

describe("issue #134 runtime wiring", () => {
  let dir: string | undefined;
  let rt: Runtime | undefined;

  afterEach(async () => {
    await rt?.stop().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
    rt = undefined;
  });

  it("the peer is given its class deadline: free 120000, priced keeps the session value", async () => {
    const d = await mkdtemp(join(tmpdir(), "stall-"));
    dir = d;
    rt = new Runtime(d, fakeHerdr, manifest(), { isFreeModel: isFree });
    await rt.spawnPeers();
    const read = async (id: string) =>
      JSON.parse(await readFile(join(d, "run-details", `.peer-${id}.json`), "utf8")) as {
        stallTimeoutMs: number;
      };
    expect((await read("free1")).stallTimeoutMs).toBe(120000);
    expect((await read("paid1")).stallTimeoutMs).toBe(300000);
  });

  /** Connect a fake peer for `agentId`; returns the frames it receives and a send fn. */
  const fakePeer = async (runtime: Runtime, agentId: string) => {
    const client = connect(runtime.bus.path);
    const frames: Frame[] = [];
    client.on("data", (d) => {
      for (const line of d.toString().split("\n"))
        if (line !== "") frames.push(JSON.parse(line) as Frame);
    });
    await new Promise<void>((r) => client.once("connect", () => r()));
    const send = (env: Record<string, unknown>) => client.write(`${JSON.stringify(env)}\n`);
    send({
      id: `reg-${agentId}`,
      timestamp: 0,
      sender: agentId,
      recipient: "supervisor",
      type: "AGENT_REGISTER",
      payload: {
        agentId,
        title: agentId,
        model: "free/x",
        permissions: { read: true, edit: true, shell: false },
        maxCostUsd: 1,
        maxTokens: 1000,
        systemPrompt: "sp",
      },
    });
    await tick();
    return { frames, send };
  };

  it("a writer role to an unproven free slug is held until its first tool call is observed", async () => {
    const d = await mkdtemp(join(tmpdir(), "stall-"));
    dir = d;
    let clock = 1_000;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstSleep = true;
    rt = new Runtime(d, fakeHerdr, manifest(), {
      now: () => clock,
      // The first probe poll parks on the gate so the test controls when the
      // slug's first tool call lands; every later tick advances the clock 1 s.
      sleep: async () => {
        if (firstSleep) {
          firstSleep = false;
          await gate;
        }
        clock += 1000;
      },
      isFreeModel: isFree,
    });
    await rt.start();
    const { frames, send } = await fakePeer(rt, "free1");

    expect(rt.dispatch("free1", order("t1"))).toBe(true);
    await tick();
    // The probe elicited a prompt; the work order has NOT reached the slug.
    expect(frames.some((f) => f.type === "PROMPT")).toBe(true);
    expect(frames.some((f) => f.type === "WORK_ORDER")).toBe(false);

    // The slug is slow to start but alive: its first tool call lands inside the window.
    const prompt = frames.find((f) => f.type === "PROMPT");
    send({
      id: "resp-1",
      correlationId: prompt?.correlationId,
      timestamp: clock,
      sender: "free1",
      recipient: "supervisor",
      type: "RESPONSE",
      payload: { agentId: "free1", text: "probing" },
    });
    await writeFile(
      join(d, "run-details", "tool-calls.jsonl"),
      `${JSON.stringify({ timestamp: clock, agentId: "free1", toolName: "read", toolCallId: "c1", isError: false })}\n`,
    );
    release();
    await vi.waitFor(() => expect(frames.some((f) => f.type === "WORK_ORDER")).toBe(true));
  });

  it("no tool call within the window: the slug is reported unproven and the order is not dispatched", async () => {
    const d = await mkdtemp(join(tmpdir(), "stall-"));
    dir = d;
    let clock = 1_000;
    rt = new Runtime(d, fakeHerdr, manifest(), {
      now: () => clock,
      sleep: async () => {
        clock += 1000;
      },
      isFreeModel: isFree,
    });
    await rt.start();
    const { frames, send } = await fakePeer(rt, "free1");

    expect(rt.dispatch("free1", order("t2"))).toBe(true);
    // The slug replies to the probe but never makes a tool call: a reply is not proof.
    await vi.waitFor(() => expect(frames.some((f) => f.type === "PROMPT")).toBe(true));
    const prompt = frames.find((f) => f.type === "PROMPT");
    send({
      id: "resp-2",
      correlationId: prompt?.correlationId,
      timestamp: clock,
      sender: "free1",
      recipient: "supervisor",
      type: "RESPONSE",
      payload: { agentId: "free1", text: "I am fine" },
    });

    const reply = await rt.awaitResponse("free1", 5_000);
    expect(reply.type).toBe("RESPONSE");
    expect((reply.payload as { text: string }).text).toMatch(/unproven/);
    expect((reply.payload as { text: string }).text).toMatch(/NOT dispatched/);
    expect(frames.some((f) => f.type === "WORK_ORDER")).toBe(false);
  });

  it("regression: the shipped template manifest (no free-class agents) — one deadline for every peer, no probe", async () => {
    const raw = await readFile("templates/session.yaml", "utf8");
    const config = parseSessionConfig(parseYaml(raw), () => false);
    for (const agent of config.agents) {
      expect(stallTimeoutForAgent(agent, config.session, () => false)).toBe(
        config.session.stall_timeout_ms,
      );
      expect(
        writerRoleNeedsProbe(
          { model: agent.model, edit: agent.permissions.edit },
          { writeScope: ["src/a.ts"] },
          0,
          () => false,
        ),
        agent.id,
      ).toBe(false);
    }

    const d = await mkdtemp(join(tmpdir(), "stall-"));
    dir = d;
    rt = new Runtime(d, fakeHerdr, config, { isFreeModel: () => false });
    await rt.spawnPeers();
    for (const agent of config.agents) {
      const peer = JSON.parse(
        await readFile(join(d, "run-details", `.peer-${agent.id}.json`), "utf8"),
      ) as { stallTimeoutMs: number };
      expect(peer.stallTimeoutMs, agent.id).toBe(config.session.stall_timeout_ms);
    }
    // And at the dispatch seam: a writer order to the priced fixer goes straight out.
    await rt.start();
    const client = connect(rt.bus.path);
    const frames: Frame[] = [];
    client.on("data", (d) => {
      for (const line of d.toString().split("\n"))
        if (line !== "") frames.push(JSON.parse(line) as Frame);
    });
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(
      `${JSON.stringify({
        id: "reg-fixer",
        timestamp: 0,
        sender: "fixer",
        recipient: "supervisor",
        type: "AGENT_REGISTER",
        payload: {
          agentId: "fixer",
          title: "fixer",
          model: "deepseek/deepseek-v4-pro",
          permissions: { read: true, edit: true, shell: true },
          maxCostUsd: 1,
          maxTokens: 250000,
          systemPrompt: "sp",
        },
      })}\n`,
    );
    await tick();
    expect(rt.dispatch("fixer", order("t3"))).toBe(true);
    await vi.waitFor(() => expect(frames.some((f) => f.type === "WORK_ORDER")).toBe(true));
    expect(frames.some((f) => f.type === "PROMPT")).toBe(false);
  });
});

describe("issue #134: the stall signal comes from tool-call activity, not replies", () => {
  it("tool_execution events reset the peer's progress flag with no reply in the turn", async () => {
    let prompts = 0;
    const listeners = new Set<(e: unknown) => void>();
    const handle = {
      prompt: async () => {
        prompts++;
      },
      getLastAssistantText: () => undefined,
      subscribe: (l: (e: unknown) => void) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      dispose: () => {},
      abort: async () => {},
    };
    const ps = new PeerSession({ createSession: async () => handle, onTextDelta: () => {} });
    const turn = ps.runTurn("go");
    await vi.waitFor(() => expect(prompts).toBe(1));
    // A turn that has made tool calls but produced no reply text.
    for (const l of listeners) {
      l({ type: "tool_execution_start" });
      l({ type: "tool_execution_end" });
    }
    const snap = ps.progressSnapshot();
    expect(snap.busy).toBe(true);
    // Tool activity alone resets the runtime's stall clock: this peer is never
    // reported stalled on the strength of its silence.
    expect(snap.progressed).toBe(true);
    for (const l of listeners) l({ type: "agent_settled" });
    await turn;
  });
});
