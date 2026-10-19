/**
 * A1-A10 from docs/trace-semantics-oracle.md, graded against the PRODUCTION
 * fields-only tracer (src/tracing/tracing.ts). Facts are recorded independently
 * of the emitted spans; the grade() oracle below is the S3 reference logic from
 * scripts/bun-s4-probe/core.ts, ported into this test (never into src/).
 */
import { describe, expect, it } from "vitest";
import { FieldsTracer, type SpanName, type SpanRecord } from "../../src/tracing/tracing";

interface Facts {
  run_id: string;
  work_orders: { taskId: string; agentId: string }[];
  prompts: { correlationId: string; from: string; to: string; sender_scope: string }[];
  tool_executions: { execution_id: string; scope_id: string; agentId: string; tool: string }[];
  validation_commands: { execution_id: string; command: string }[];
  justified_links: { from_scope: string; to_scope: string; reason: string }[];
  concurrency: { a: string; b: string }[];
}

type Kind = "run-level" | "work-order-level";

const NAME_KIND: Record<SpanName, Kind> = {
  run: "run-level",
  finalize: "run-level",
  "validation.command": "run-level",
  dispatch: "work-order-level",
  "peer.turn": "work-order-level",
  tool: "work-order-level",
  final_report: "work-order-level",
  prompt: "work-order-level",
};

function grade(spans: SpanRecord[], facts: Facts): string[] {
  const failures: string[] = [];
  const fail = (id: string, msg: string) => failures.push(`${id}: ${msg}`);
  const byName = (n: SpanName) => spans.filter((s) => s.name === n);
  const byScope = (scope: string) => spans.filter((s) => s.scope_id === scope);
  const spanById = new Map<string, SpanRecord>(spans.map((s) => [s.span_id, s]));

  // A1 — trace identity + id format
  {
    const runs = byName("run");
    if (runs.length !== 1) fail("A1", `expected 1 run span, got ${runs.length}`);
    const run = runs[0];
    if (run && run.parent_span_id !== null) fail("A1", "run parent_span_id must be null");
    if (new Set(spans.map((s) => s.trace_id)).size !== 1)
      fail("A1", "spans share more than one trace_id");
    for (const s of spans) {
      if (!/^[0-9a-f]{32}$/.test(s.trace_id) || s.trace_id === "0".repeat(32))
        fail("A1", `bad trace_id ${s.trace_id}`);
      if (!/^[0-9a-f]{16}$/.test(s.span_id) || s.span_id === "0".repeat(16))
        fail("A1", `bad span_id ${s.span_id}`);
    }
    const ids = spans.map((s) => s.span_id);
    if (new Set(ids).size !== ids.length) fail("A1", "duplicate span_id");
  }

  // A2 — classification
  for (const s of spans) {
    const expected = NAME_KIND[s.name];
    if (s.kind !== expected) fail("A2", `${s.name} kind=${s.kind}, expected ${expected}`);
    if (s.kind === "work-order-level" && !s.scope_id) fail("A2", `${s.name} missing scope_id`);
    if (s.kind === "run-level" && s.scope_id !== null)
      fail("A2", `${s.name} has scope_id=${s.scope_id}`);
  }

  // A3 — scope membership
  for (const wo of facts.work_orders) {
    const names = new Set(byScope(wo.taskId).map((s) => s.name));
    const allowed = new Set<SpanName>(["dispatch", "peer.turn", "tool", "final_report"]);
    for (const n of names) if (!allowed.has(n)) fail("A3", `work order ${wo.taskId} has span ${n}`);
    if (!names.has("dispatch") || !names.has("final_report") || !names.has("peer.turn"))
      fail("A3", `work order ${wo.taskId} missing a required span: ${[...names].join(",")}`);
  }
  for (const p of facts.prompts) {
    const names = new Set(byScope(p.correlationId).map((s) => s.name));
    const allowed = new Set<SpanName>(["prompt", "peer.turn", "tool"]);
    for (const n of names)
      if (!allowed.has(n)) fail("A3", `prompt ${p.correlationId} has span ${n}`);
    if (names.has("final_report"))
      fail("A3", `prompt ${p.correlationId} must not have final_report`);
  }
  {
    const known = new Set([
      ...facts.work_orders.map((w) => w.taskId),
      ...facts.prompts.map((p) => p.correlationId),
    ]);
    for (const s of spans)
      if (s.kind === "work-order-level" && s.scope_id !== null && !known.has(s.scope_id))
        fail("A3", `${s.name} has unknown scope ${s.scope_id}`);
  }

  // A4 — in-process parent
  {
    const run = byName("run")[0];
    for (const d of byName("dispatch"))
      if (d.parent_span_id !== run?.span_id) fail("A4", `dispatch ${d.operation_id} parent != run`);
    const finalize = byName("finalize")[0];
    for (const f of byName("finalize"))
      if (f.parent_span_id !== run?.span_id) fail("A4", "finalize parent != run");
    for (const v of byName("validation.command"))
      if (v.parent_span_id !== finalize?.span_id)
        fail("A4", `validation.command ${v.operation_id} parent != finalize`);
    for (const t of byName("tool")) {
      const p = spanById.get(t.parent_span_id ?? "");
      if (p?.name !== "peer.turn") fail("A4", `tool ${t.operation_id} parent is not peer.turn`);
      else if (p.scope_id !== t.scope_id)
        fail("A4", `tool ${t.operation_id} scope ${t.scope_id} != turn ${p.scope_id}`);
    }
    for (const fr of byName("final_report")) {
      const p = spanById.get(fr.parent_span_id ?? "");
      if (p?.name !== "dispatch")
        fail("A4", `final_report ${fr.operation_id} parent is not dispatch`);
      else if (p.scope_id !== fr.scope_id)
        fail("A4", `final_report ${fr.operation_id} scope != dispatch scope`);
    }
  }

  // A5 — cross-process parent
  for (const wo of facts.work_orders) {
    const dispatch = spans.find((s) => s.name === "dispatch" && s.scope_id === wo.taskId);
    if (!dispatch) {
      fail("A5", `no dispatch for ${wo.taskId}`);
      continue;
    }
    const turns = spans.filter((s) => s.name === "peer.turn" && s.scope_id === wo.taskId);
    if (turns.length === 0) fail("A5", `no peer.turn for ${wo.taskId}`);
    for (const t of turns)
      if (t.parent_span_id !== dispatch.span_id)
        fail(
          "A5",
          `peer.turn(${wo.taskId}) parent ${t.parent_span_id} != dispatch ${dispatch.span_id}`,
        );
  }
  for (const p of facts.prompts) {
    const prompt = spans.find((s) => s.name === "prompt" && s.scope_id === p.correlationId);
    if (!prompt) {
      fail("A5", `no prompt for ${p.correlationId}`);
      continue;
    }
    const turns = spans.filter((s) => s.name === "peer.turn" && s.scope_id === p.correlationId);
    if (turns.length === 0) fail("A5", `no peer.turn for ${p.correlationId}`);
    for (const t of turns)
      if (t.parent_span_id !== prompt.span_id)
        fail("A5", `peer.turn(${p.correlationId}) parent != prompt`);
  }

  // A6 — parent isolation
  for (const s of spans) {
    if (s.kind !== "work-order-level") continue;
    if (s.name === "dispatch" || s.name === "prompt") continue;
    const p = spanById.get(s.parent_span_id ?? "");
    if (!p) {
      fail("A6", `${s.name} ${s.operation_id ?? ""} dangling parent ${s.parent_span_id}`);
      continue;
    }
    if (p.scope_id !== s.scope_id)
      fail(
        "A6",
        `${s.name} ${s.operation_id ?? ""} (scope ${s.scope_id}) parent scope ${p.scope_id}`,
      );
  }
  for (const p of facts.prompts) {
    const prompt = spans.find((s) => s.name === "prompt" && s.scope_id === p.correlationId);
    if (!prompt) continue;
    const parent = spanById.get(prompt.parent_span_id ?? "");
    if (!parent) {
      fail("A6", `prompt ${p.correlationId} dangling parent`);
      continue;
    }
    if (p.sender_scope === "run") {
      if (parent.name !== "run")
        fail("A6", `prompt ${p.correlationId} sender_scope=run but parent=${parent.name}`);
    } else if (parent.scope_id !== p.sender_scope) {
      fail(
        "A6",
        `prompt ${p.correlationId} sender_scope=${p.sender_scope} but parent scope=${parent.scope_id}`,
      );
    }
  }
  for (const pair of facts.concurrency) {
    for (const s of spans) {
      const p = s.scope_id === pair.a ? spanById.get(s.parent_span_id ?? "") : undefined;
      if (p && p.scope_id === pair.b)
        fail("A6", `${s.name} scoped ${pair.a} parents into ${pair.b}`);
    }
    for (const s of spans) {
      const p = s.scope_id === pair.b ? spanById.get(s.parent_span_id ?? "") : undefined;
      if (p && p.scope_id === pair.a)
        fail("A6", `${s.name} scoped ${pair.b} parents into ${pair.a}`);
    }
  }

  // A7 — completeness
  for (const s of spans) {
    if (s.end_time === null) fail("A7", `${s.name} ${s.operation_id ?? ""} left open`);
    else if (s.end_time < s.start_time) fail("A7", `${s.name} ${s.operation_id ?? ""} end < start`);
  }
  {
    const run = byName("run")[0];
    const maxEnd = Math.max(...spans.map((s) => s.end_time ?? 0));
    if (run && run.end_time !== null && run.end_time < maxEnd)
      fail("A7", `run.end_time ${run.end_time} < terminal ${maxEnd}`);
  }

  // A8 — link validity
  for (const s of spans) {
    for (const l of s.links) {
      if (l.span_id === s.parent_span_id) fail("A8", `${s.name} links its own parent`);
      const target = spanById.get(l.span_id);
      if (!target) {
        fail("A8", `${s.name} links unknown span ${l.span_id}`);
        continue;
      }
      const fromScope = s.scope_id ?? "run";
      const toScope = target.scope_id ?? "run";
      if (fromScope === toScope) fail("A8", `${s.name} links same-scope span`);
      const justified = facts.justified_links.some(
        (j) => j.from_scope === fromScope && j.to_scope === toScope && j.reason === l.reason,
      );
      if (!justified)
        fail("A8", `${s.name} link ${fromScope}->${toScope} (${l.reason}) not justified`);
    }
  }

  // A9 — coverage (facts -> spans)
  for (const wo of facts.work_orders) {
    if (spans.filter((s) => s.name === "dispatch" && s.operation_id === wo.taskId).length !== 1)
      fail("A9", `work order ${wo.taskId}: dispatch != 1`);
    if (spans.filter((s) => s.name === "final_report" && s.operation_id === wo.taskId).length !== 1)
      fail("A9", `work order ${wo.taskId}: final_report != 1`);
    if (spans.filter((s) => s.name === "peer.turn" && s.scope_id === wo.taskId).length < 1)
      fail("A9", `work order ${wo.taskId}: peer.turn < 1`);
  }
  for (const p of facts.prompts) {
    if (spans.filter((s) => s.name === "prompt" && s.operation_id === p.correlationId).length !== 1)
      fail("A9", `prompt ${p.correlationId}: prompt != 1`);
    if (spans.filter((s) => s.name === "peer.turn" && s.scope_id === p.correlationId).length < 1)
      fail("A9", `prompt ${p.correlationId}: peer.turn < 1`);
  }
  for (const te of facts.tool_executions) {
    const ts = spans.filter((s) => s.name === "tool" && s.operation_id === te.execution_id);
    if (ts.length !== 1) {
      fail("A9", `tool ${te.execution_id}: span count ${ts.length}`);
      continue;
    }
    const t = ts[0];
    if (!t) continue;
    if (t.scope_id !== te.scope_id) fail("A9", `tool ${te.execution_id} scope mismatch`);
    if (t.agent_id !== te.agentId) fail("A9", `tool ${te.execution_id} agent mismatch`);
    if (t.attributes?.tool !== te.tool) fail("A9", `tool ${te.execution_id} tool mismatch`);
  }
  for (const vc of facts.validation_commands) {
    const vs = spans.filter(
      (s) => s.name === "validation.command" && s.operation_id === vc.execution_id,
    );
    if (vs.length !== 1) {
      fail("A9", `validation ${vc.execution_id}: span count ${vs.length}`);
      continue;
    }
    const v = vs[0];
    if (v && v.attributes?.command !== vc.command)
      fail("A9", `validation ${vc.execution_id} command mismatch`);
  }

  // A10 — reverse coverage, bijection per operational type
  const operational: SpanName[] = [
    "dispatch",
    "final_report",
    "prompt",
    "tool",
    "validation.command",
  ];
  for (const s of spans) {
    if (!operational.includes(s.name)) continue;
    if (!s.operation_id) {
      fail("A10", `${s.name} missing operation_id`);
      continue;
    }
    const op = s.operation_id;
    let factCount = 0;
    if (s.name === "dispatch" || s.name === "final_report")
      factCount = facts.work_orders.filter((w) => w.taskId === op).length;
    else if (s.name === "prompt")
      factCount = facts.prompts.filter((p) => p.correlationId === op).length;
    else if (s.name === "tool")
      factCount = facts.tool_executions.filter((t) => t.execution_id === op).length;
    else if (s.name === "validation.command")
      factCount = facts.validation_commands.filter((v) => v.execution_id === op).length;
    if (factCount !== 1) fail("A10", `${s.name} ${op} matches ${factCount} facts`);
  }

  return failures;
}

describe("A1-A10 oracle against the production FieldsTracer", () => {
  it("a full run with work orders, a prompt, tools, and validation passes every assertion", () => {
    const facts: Facts = {
      run_id: "r1",
      work_orders: [
        { taskId: "T1", agentId: "peer1" },
        { taskId: "T2", agentId: "peer2" },
      ],
      prompts: [{ correlationId: "C1", from: "supervisor", to: "peer1", sender_scope: "run" }],
      tool_executions: [
        { execution_id: "tool-1", scope_id: "T1", agentId: "peer1", tool: "read" },
        { execution_id: "tool-2", scope_id: "T2", agentId: "peer2", tool: "edit" },
        { execution_id: "tool-3", scope_id: "C1", agentId: "peer1", tool: "bash" },
      ],
      validation_commands: [
        { execution_id: "val-1", command: "just test" },
        { execution_id: "val-2", command: "just lint" },
      ],
      justified_links: [],
      concurrency: [{ a: "T1", b: "T2" }],
    };

    const supervisor = new FieldsTracer();
    const peer = new FieldsTracer();

    const run = supervisor.startSpan("run", {
      parent: null,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    const d1 = supervisor.startSpan("dispatch", {
      parent: run,
      kind: "work-order-level",
      scopeId: "T1",
      agentId: null,
      operationId: "T1",
    });
    const d2 = supervisor.startSpan("dispatch", {
      parent: run,
      kind: "work-order-level",
      scopeId: "T2",
      agentId: null,
      operationId: "T2",
    });
    const prompt = supervisor.startSpan("prompt", {
      parent: run,
      kind: "work-order-level",
      scopeId: "C1",
      agentId: null,
      operationId: "C1",
    });

    // Cross-process: supervisor injects, peer extracts, and the trace_id crosses.
    const carrier1: Record<string, unknown> = {};
    supervisor.inject(carrier1, d1);
    const turn1 = peer.startSpan("peer.turn", {
      parent: peer.extract(carrier1),
      kind: "work-order-level",
      scopeId: "T1",
      agentId: "peer1",
    });
    const tool1 = peer.startSpan("tool", {
      parent: turn1,
      kind: "work-order-level",
      scopeId: "T1",
      agentId: "peer1",
      operationId: "tool-1",
      attrs: { tool: "read" },
    });
    peer.endSpan(tool1);
    peer.endSpan(turn1);

    const carrier2: Record<string, unknown> = {};
    supervisor.inject(carrier2, d2);
    const turn2 = peer.startSpan("peer.turn", {
      parent: peer.extract(carrier2),
      kind: "work-order-level",
      scopeId: "T2",
      agentId: "peer2",
    });
    const tool2 = peer.startSpan("tool", {
      parent: turn2,
      kind: "work-order-level",
      scopeId: "T2",
      agentId: "peer2",
      operationId: "tool-2",
      attrs: { tool: "edit" },
    });
    peer.endSpan(tool2);
    peer.endSpan(turn2);

    const carrier3: Record<string, unknown> = {};
    supervisor.inject(carrier3, prompt);
    const turn3 = peer.startSpan("peer.turn", {
      parent: peer.extract(carrier3),
      kind: "work-order-level",
      scopeId: "C1",
      agentId: "peer1",
    });
    const tool3 = peer.startSpan("tool", {
      parent: turn3,
      kind: "work-order-level",
      scopeId: "C1",
      agentId: "peer1",
      operationId: "tool-3",
      attrs: { tool: "bash" },
    });
    peer.endSpan(tool3);
    peer.endSpan(turn3);
    supervisor.endSpan(prompt);

    const fr1 = supervisor.startSpan("final_report", {
      parent: d1,
      kind: "work-order-level",
      scopeId: "T1",
      agentId: null,
      operationId: "T1",
    });
    supervisor.endSpan(fr1);
    supervisor.endSpan(d1);
    const fr2 = supervisor.startSpan("final_report", {
      parent: d2,
      kind: "work-order-level",
      scopeId: "T2",
      agentId: null,
      operationId: "T2",
    });
    supervisor.endSpan(fr2);
    supervisor.endSpan(d2);

    const finalize = supervisor.startSpan("finalize", {
      parent: run,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    const v1 = supervisor.startSpan("validation.command", {
      parent: finalize,
      kind: "run-level",
      scopeId: null,
      agentId: null,
      operationId: "val-1",
      attrs: { command: "just test" },
    });
    supervisor.endSpan(v1);
    const v2 = supervisor.startSpan("validation.command", {
      parent: finalize,
      kind: "run-level",
      scopeId: null,
      agentId: null,
      operationId: "val-2",
      attrs: { command: "just lint" },
    });
    supervisor.endSpan(v2);
    supervisor.endSpan(finalize);
    supervisor.endSpan(run);

    const spans = [...supervisor.collect(), ...peer.collect()];
    expect(grade(spans, facts)).toEqual([]);
  });

  it("a span left open fails A7, proving the oracle is not vacuous", () => {
    const t = new FieldsTracer();
    const run = t.startSpan("run", {
      parent: null,
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    t.startSpan("dispatch", {
      parent: run,
      kind: "work-order-level",
      scopeId: "T1",
      agentId: null,
      operationId: "T1",
    });
    const facts: Facts = {
      run_id: "r1",
      work_orders: [{ taskId: "T1", agentId: "peer1" }],
      prompts: [],
      tool_executions: [],
      validation_commands: [],
      justified_links: [],
      concurrency: [],
    };
    expect(grade(t.collect(), facts).some((f) => f.startsWith("A7"))).toBe(true);
  });
});
