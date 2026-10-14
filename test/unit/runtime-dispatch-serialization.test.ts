/**
 * Ob-1 + A8 of the runtime dispatch core.
 *
 * Ob-1: every conversation.jsonl entry written by Runtime.log() carries the
 * injected now() clock as a numeric timestamp.
 *
 * A8: same-connection frame dispatch is serialized across the async gate —
 * frame 1 (100 ms classifier delay) completes handleEnvelope strictly before
 * frame 2 (10 ms delay) begins. Witness: handleEnvelope's first act is a log()
 * entry, and each entry's timestamp comes from a monotonic injected clock, so
 * timestamp order IS dispatch order regardless of file-append timing; the
 * FINAL_REPORT arms are synchronous, so a later timestamp also proves the
 * earlier arm had completed.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";
import type { InjectionEstimate } from "../../src/jev/injection-gate";
import { Runtime } from "../../src/runtime/runtime";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p1",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};

const config = parseSessionConfig({
  version: "1.1",
  session: {
    id: "s1",
    max_cost_usd: 5,
    agent_stop_threshold_percent: 85,
    attester: "peer1",
    jev: { injection_check: true, injection_threshold: 0.8, injection_timeout_ms: 2000 },
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

const REGISTER = {
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

const reportFrame = (id: string, report: string) => ({
  id,
  timestamp: 0,
  sender: "peer1",
  recipient: "supervisor",
  type: "FINAL_REPORT",
  payload: { agentId: "peer1", report },
});

async function readEntries(rt: Runtime, dir: string) {
  await rt.flush();
  return (await readFile(join(dir, "run-details", "conversation.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("runtime dispatch (same connection)", () => {
  let dir: string | undefined;
  let rt: Runtime | undefined;

  afterEach(async () => {
    await rt?.stop().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("log() entries carry the injected now() clock as a numeric timestamp (Ob-1)", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-ob1-"));
    rt = new Runtime(dir, fakeHerdr, config, { now: () => 424242 });
    await rt.start();
    expect(
      rt.dispatch("peer1", {
        taskId: "t1",
        action: "a",
        contextFiles: [],
        constraints: [],
        localDoD: "d",
      }),
    ).toBe(true);
    const wo = (await readEntries(rt, dir)).find((e) => e.type === "WORK_ORDER");
    expect(wo).toBeDefined();
    expect(typeof wo.timestamp).toBe("number");
    expect(wo.timestamp).toBe(424242);
  });

  it("serializes dispatch: frame 1 (100 ms gate) is handled strictly before frame 2 (10 ms gate) (A8)", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-a8-"));
    // Monotonic clock: every log() timestamp records call order.
    let t = 0;
    const now = () => ++t;
    let estimateCalls = 0;
    const estimate: InjectionEstimate = async (content) => {
      estimateCalls += 1;
      await new Promise((r) => setTimeout(r, content.includes("slow") ? 100 : 10));
      return 0.1;
    };
    const opts = { now, injectionEstimate: estimate };
    rt = new Runtime(dir, fakeHerdr, config, opts);
    await rt.start();
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(`${JSON.stringify(REGISTER)}\n`);
    await vi.waitUntil(() => rt!.registry.has("peer1"));
    // Two frames on the SAME connection, back-to-back writes: the slower
    // classifier must not let frame 2 jump the dispatch queue.
    client.write(`${JSON.stringify(reportFrame("f1", "first slow report"))}\n`);
    client.write(`${JSON.stringify(reportFrame("f2", "second fast report"))}\n`);
    await new Promise((r) => setTimeout(r, 400)); // both 100/10 ms gates settled
    const entries = await readEntries(rt, dir);
    client.destroy();
    // Both frames were screened on this connection (red until the wiring lands).
    expect(estimateCalls).toBe(2);
    expect(entries.filter((e) => String(e.event).startsWith("injection_"))).toHaveLength(2);
    // Dispatch order = log-timestamp order: f1 strictly before f2.
    const ts = (id: string) => entries.find((e) => e.id === id)?.timestamp as number;
    expect(typeof ts("f1")).toBe("number");
    expect(typeof ts("f2")).toBe("number");
    expect(ts("f1")).toBeLessThan(ts("f2"));
  });
});
