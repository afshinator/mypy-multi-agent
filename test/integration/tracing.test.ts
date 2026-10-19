/**
 * Integration test: supervisor-side span minting over the real bus — dispatch
 * injects traceparent onto WORK_ORDER, final_report/finalize/validation.command
 * mint under the run span.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";
import { Runtime } from "../../src/runtime/runtime";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p1",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};

const PASS = [{ criterion: "dod", result: "pass" as const, evidence: "verified" }];

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
  validation: { commands: ["just test", "just lint"] },
});

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("Runtime tracing", () => {
  let dir: string | undefined;
  let rt: Runtime | undefined;

  afterEach(async () => {
    await rt?.stop().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("mints run/dispatch/final_report/finalize/validation.command and injects traceparent", async () => {
    dir = await mkdtemp(join(tmpdir(), "rt-trace-"));
    const exec = vi.fn(async () => true);
    rt = new Runtime(dir, fakeHerdr, config, { execValidation: exec });
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

    expect(
      rt.dispatch("peer1", {
        taskId: "T1",
        action: "do x",
        contextFiles: [],
        constraints: [],
        localDoD: "d",
      }),
    ).toBe(true);
    await tick();

    const workOrderLine = received.find((f) => f.includes('"type":"WORK_ORDER"'));
    expect(workOrderLine).toBeDefined();
    const wo = JSON.parse(workOrderLine ?? "{}") as { traceparent?: string };
    expect(wo.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const spansAfterDispatch = rt.tracer.collect();
    const dispatch = spansAfterDispatch.find((s) => s.name === "dispatch");
    const run = spansAfterDispatch.find((s) => s.name === "run");
    expect(run).toMatchObject({
      parent_span_id: null,
      kind: "run-level",
      scope_id: null,
      end_time: null,
    });
    expect(dispatch).toMatchObject({
      parent_span_id: run?.span_id,
      kind: "work-order-level",
      scope_id: "T1",
      operation_id: "T1",
      end_time: null,
    });
    // The injected traceparent carries the dispatch span id in this run's trace.
    const [, traceId, spanId] = (wo.traceparent ?? "00-0-0-01").split("-");
    expect(traceId).toBe(run?.trace_id);
    expect(spanId).toBe(dispatch?.span_id);

    send({
      id: "f1",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type: "FINAL_REPORT",
      payload: { agentId: "peer1", report: "done" },
    });
    await tick();

    const spansAfterReport = rt.tracer.collect();
    expect(spansAfterReport.find((s) => s.name === "dispatch")?.end_time).not.toBeNull();
    const finalReport = spansAfterReport.find((s) => s.name === "final_report");
    expect(finalReport).toMatchObject({
      parent_span_id: dispatch?.span_id,
      scope_id: "T1",
      operation_id: "T1",
      end_time: expect.any(Number),
    });

    rt.changeDetector.markChanged();
    await rt.finalize(true, undefined, undefined, PASS);

    const spans = rt.tracer.collect();
    expect(spans.find((s) => s.name === "run")?.end_time).not.toBeNull();
    const finalize = spans.find((s) => s.name === "finalize");
    expect(finalize).toMatchObject({
      parent_span_id: run?.span_id,
      kind: "run-level",
      scope_id: null,
      end_time: expect.any(Number),
    });
    const validations = spans.filter((s) => s.name === "validation.command");
    expect(validations).toHaveLength(2);
    expect(validations.map((v) => v.parent_span_id)).toEqual([
      finalize?.span_id,
      finalize?.span_id,
    ]);
    expect(validations.every((v) => v.scope_id === null && v.kind === "run-level")).toBe(true);
    expect(new Set(validations.map((v) => v.operation_id)).size).toBe(2);
    expect(validations.map((v) => v.attributes?.command).sort()).toEqual([
      "just lint",
      "just test",
    ]);
    expect(exec).toHaveBeenCalledTimes(2);

    client.destroy();
  });
});
