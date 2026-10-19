import { randomBytes } from "node:crypto";

export type SpanName =
  | "run" | "finalize" | "validation.command"
  | "dispatch" | "peer.turn" | "tool" | "final_report"
  | "prompt";
export type Kind = "run-level" | "work-order-level";

export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: SpanName;
  kind: Kind;
  scope_id: string | null;
  agent_id: string | null;
  start_time: number;
  end_time: number | null;
  status: "ok" | "error" | "aborted";
  links: Array<{ span_id: string; reason: string }>;
  operation_id?: string;
  attributes?: Record<string, unknown>;
}

export interface Facts {
  run_id: string;
  work_orders: { taskId: string; agentId: string }[];
  prompts: { correlationId: string; from: string; to: string; sender_scope: string }[];
  tool_executions: { execution_id: string; scope_id: string; agentId: string; tool: string }[];
  validation_commands: { execution_id: string; command: string }[];
  justified_links: { from_scope: string; to_scope: string; reason: string }[];
  concurrency: { a: string; b: string }[];
}

const NAME_KIND: Record<SpanName, Kind> = {
  run: "run-level", finalize: "run-level", "validation.command": "run-level",
  dispatch: "work-order-level", "peer.turn": "work-order-level", tool: "work-order-level",
  final_report: "work-order-level", prompt: "work-order-level",
};

export const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}
export function parseTraceparent(tp: string): { traceId: string; spanId: string } | null {
  const parts = tp.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, spanId] = parts;
  if (version !== "00") return null;
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) return null;
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return null;
  return { traceId, spanId };
}

export function grade(spans: SpanRecord[], facts: Facts): string[] {
  const failures: string[] = [];
  const fail = (id: string, msg: string) => failures.push(`${id}: ${msg}`);
  const byName = (n: SpanName) => spans.filter((s) => s.name === n);
  const byScope = (scope: string) => spans.filter((s) => s.scope_id === scope);
  const spanById = new Map(spans.map((s) => [s.span_id, s]));

  // A1 — trace identity + id format
  {
    const runs = byName("run");
    if (runs.length !== 1) fail("A1", `expected 1 run span, got ${runs.length}`);
    if (runs[0] && runs[0].parent_span_id !== null) fail("A1", "run parent_span_id must be null");
    if (new Set(spans.map((s) => s.trace_id)).size !== 1) fail("A1", "spans share more than one trace_id");
    for (const s of spans) {
      if (!/^[0-9a-f]{32}$/.test(s.trace_id) || s.trace_id === "0".repeat(32)) fail("A1", `bad trace_id ${s.trace_id}`);
      if (!/^[0-9a-f]{16}$/.test(s.span_id) || s.span_id === "0".repeat(16)) fail("A1", `bad span_id ${s.span_id}`);
    }
    const ids = spans.map((s) => s.span_id);
    if (new Set(ids).size !== ids.length) fail("A1", "duplicate span_id");
  }

  // A2 — classification
  for (const s of spans) {
    const expected = NAME_KIND[s.name];
    if (s.kind !== expected) fail("A2", `${s.name} kind=${s.kind}, expected ${expected}`);
    if (s.kind === "work-order-level" && !s.scope_id) fail("A2", `${s.name} missing scope_id`);
    if (s.kind === "run-level" && s.scope_id !== null) fail("A2", `${s.name} has scope_id=${s.scope_id}`);
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
    for (const n of names) if (!allowed.has(n)) fail("A3", `prompt ${p.correlationId} has span ${n}`);
    if (names.has("final_report")) fail("A3", `prompt ${p.correlationId} must not have final_report`);
  }
  {
    const known = new Set([...facts.work_orders.map((w) => w.taskId), ...facts.prompts.map((p) => p.correlationId)]);
    for (const s of spans)
      if (s.kind === "work-order-level" && s.scope_id !== null && !known.has(s.scope_id))
        fail("A3", `${s.name} has unknown scope ${s.scope_id}`);
  }

  // A4 — in-process parent
  {
    const run = byName("run")[0];
    for (const d of byName("dispatch")) if (d.parent_span_id !== run?.span_id) fail("A4", `dispatch ${d.operation_id} parent != run`);
    const finalize = byName("finalize")[0];
    for (const f of byName("finalize")) if (f.parent_span_id !== run?.span_id) fail("A4", "finalize parent != run");
    for (const v of byName("validation.command")) if (v.parent_span_id !== finalize?.span_id) fail("A4", `validation.command ${v.operation_id} parent != finalize`);
    for (const t of byName("tool")) {
      const p = spanById.get(t.parent_span_id ?? "");
      if (!p || p.name !== "peer.turn") fail("A4", `tool ${t.operation_id} parent is not peer.turn`);
      else if (p.scope_id !== t.scope_id) fail("A4", `tool ${t.operation_id} scope ${t.scope_id} != turn ${p.scope_id}`);
    }
    for (const fr of byName("final_report")) {
      const p = spanById.get(fr.parent_span_id ?? "");
      if (!p || p.name !== "dispatch") fail("A4", `final_report ${fr.operation_id} parent is not dispatch`);
      else if (p.scope_id !== fr.scope_id) fail("A4", `final_report ${fr.operation_id} scope != dispatch scope`);
    }
  }

  // A5 — cross-process parent (D4b)
  for (const wo of facts.work_orders) {
    const dispatch = spans.find((s) => s.name === "dispatch" && s.scope_id === wo.taskId);
    if (!dispatch) { fail("A5", `no dispatch for ${wo.taskId}`); continue; }
    const turns = spans.filter((s) => s.name === "peer.turn" && s.scope_id === wo.taskId);
    if (turns.length === 0) fail("A5", `no peer.turn for ${wo.taskId}`);
    for (const t of turns) if (t.parent_span_id !== dispatch.span_id) fail("A5", `peer.turn(${wo.taskId}) parent ${t.parent_span_id} != dispatch ${dispatch.span_id}`);
  }
  for (const p of facts.prompts) {
    const prompt = spans.find((s) => s.name === "prompt" && s.scope_id === p.correlationId);
    if (!prompt) { fail("A5", `no prompt for ${p.correlationId}`); continue; }
    const turns = spans.filter((s) => s.name === "peer.turn" && s.scope_id === p.correlationId);
    if (turns.length === 0) fail("A5", `no peer.turn for ${p.correlationId}`);
    for (const t of turns) if (t.parent_span_id !== prompt.span_id) fail("A5", `peer.turn(${p.correlationId}) parent != prompt`);
  }

  // A6 — parent isolation
  for (const s of spans) {
    if (s.kind !== "work-order-level") continue;
    if (s.name === "dispatch" || s.name === "prompt") continue;
    const p = spanById.get(s.parent_span_id ?? "");
    if (!p) { fail("A6", `${s.name} ${s.operation_id ?? ""} dangling parent ${s.parent_span_id}`); continue; }
    if (p.scope_id !== s.scope_id) fail("A6", `${s.name} ${s.operation_id ?? ""} (scope ${s.scope_id}) parent scope ${p.scope_id}`);
  }
  for (const p of facts.prompts) {
    const prompt = spans.find((s) => s.name === "prompt" && s.scope_id === p.correlationId);
    if (!prompt) continue;
    const parent = spanById.get(prompt.parent_span_id ?? "");
    if (!parent) { fail("A6", `prompt ${p.correlationId} dangling parent`); continue; }
    if (p.sender_scope === "run") {
      if (parent.name !== "run") fail("A6", `prompt ${p.correlationId} sender_scope=run but parent=${parent.name}`);
    } else if (parent.scope_id !== p.sender_scope) {
      fail("A6", `prompt ${p.correlationId} sender_scope=${p.sender_scope} but parent scope=${parent.scope_id}`);
    }
  }
  for (const pair of facts.concurrency) {
    for (const s of spans) {
      const p = s.scope_id === pair.a ? spanById.get(s.parent_span_id ?? "") : undefined;
      if (p && p.scope_id === pair.b) fail("A6", `${s.name} scoped ${pair.a} parents into ${pair.b}`);
    }
    for (const s of spans) {
      const p = s.scope_id === pair.b ? spanById.get(s.parent_span_id ?? "") : undefined;
      if (p && p.scope_id === pair.a) fail("A6", `${s.name} scoped ${pair.b} parents into ${pair.a}`);
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
    // 5ms tolerance: the SDK's HrTime clock can jitter sub-millisecond vs Date.now.
    if (run && run.end_time !== null && run.end_time < maxEnd - 5) fail("A7", `run.end_time ${run.end_time} < terminal ${maxEnd}`);
  }

  // A8 — link validity
  for (const s of spans) {
    for (const l of s.links) {
      if (l.span_id === s.parent_span_id) fail("A8", `${s.name} links its own parent`);
      const target = spanById.get(l.span_id);
      if (!target) { fail("A8", `${s.name} links unknown span ${l.span_id}`); continue; }
      const fromScope = s.scope_id ?? "run";
      const toScope = target.scope_id ?? "run";
      if (fromScope === toScope) fail("A8", `${s.name} links same-scope span`);
      const justified = facts.justified_links.some((j) => j.from_scope === fromScope && j.to_scope === toScope && j.reason === l.reason);
      if (!justified) fail("A8", `${s.name} link ${fromScope}->${toScope} (${l.reason}) not justified`);
    }
  }

  // A9 — coverage (facts -> spans)
  for (const wo of facts.work_orders) {
    if (spans.filter((s) => s.name === "dispatch" && s.operation_id === wo.taskId).length !== 1) fail("A9", `work order ${wo.taskId}: dispatch != 1`);
    if (spans.filter((s) => s.name === "final_report" && s.operation_id === wo.taskId).length !== 1) fail("A9", `work order ${wo.taskId}: final_report != 1`);
    if (spans.filter((s) => s.name === "peer.turn" && s.scope_id === wo.taskId).length < 1) fail("A9", `work order ${wo.taskId}: peer.turn < 1`);
  }
  for (const p of facts.prompts) {
    if (spans.filter((s) => s.name === "prompt" && s.operation_id === p.correlationId).length !== 1) fail("A9", `prompt ${p.correlationId}: prompt != 1`);
    if (spans.filter((s) => s.name === "peer.turn" && s.scope_id === p.correlationId).length < 1) fail("A9", `prompt ${p.correlationId}: peer.turn < 1`);
  }
  for (const te of facts.tool_executions) {
    const ts = spans.filter((s) => s.name === "tool" && s.operation_id === te.execution_id);
    if (ts.length !== 1) { fail("A9", `tool ${te.execution_id}: span count ${ts.length}`); continue; }
    const t = ts[0];
    if (t.scope_id !== te.scope_id) fail("A9", `tool ${te.execution_id} scope mismatch`);
    if (t.agent_id !== te.agentId) fail("A9", `tool ${te.execution_id} agent mismatch`);
    if (t.attributes?.tool !== te.tool) fail("A9", `tool ${te.execution_id} tool mismatch`);
  }
  for (const vc of facts.validation_commands) {
    const vs = spans.filter((s) => s.name === "validation.command" && s.operation_id === vc.execution_id);
    if (vs.length !== 1) { fail("A9", `validation ${vc.execution_id}: span count ${vs.length}`); continue; }
    if (vs[0].attributes?.command !== vc.command) fail("A9", `validation ${vc.execution_id} command mismatch`);
  }

  // A10 — reverse coverage (spans -> facts), bijection per operational type
  const operational: SpanName[] = ["dispatch", "final_report", "prompt", "tool", "validation.command"];
  for (const s of spans) {
    if (!operational.includes(s.name)) continue;
    if (!s.operation_id) { fail("A10", `${s.name} missing operation_id`); continue; }
    const op = s.operation_id;
    let factCount = 0;
    if (s.name === "dispatch" || s.name === "final_report") factCount = facts.work_orders.filter((w) => w.taskId === op).length;
    else if (s.name === "prompt") factCount = facts.prompts.filter((p) => p.correlationId === op).length;
    else if (s.name === "tool") factCount = facts.tool_executions.filter((t) => t.execution_id === op).length;
    else if (s.name === "validation.command") factCount = facts.validation_commands.filter((v) => v.execution_id === op).length;
    if (factCount !== 1) fail("A10", `${s.name} ${op} matches ${factCount} facts`);
  }

  return failures;
}
