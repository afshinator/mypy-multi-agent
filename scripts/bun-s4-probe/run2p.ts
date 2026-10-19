/** Two-process probe: supervisor in this process, peers as spawned `bun` child
 * processes over a real unix socket. The peer has no other channel to learn the
 * supervisor's span id, so a matching parent proves the traceparent crossed the
 * socket. */
import { createServer, type Socket } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomHex, grade, parseTraceparent, type Facts, type SpanRecord } from "./core";
import { FieldsOnly, OtelSdk, type Tracing, type SpanHandle } from "./strategies";
import { makeFacts, makeScripts } from "./scenario";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function run2p(tracing: Tracing): Promise<{ spans: SpanRecord[]; facts: Facts; prop: { key: string; ok: boolean; parent: string }[] }> {
  const facts = makeFacts();
  const scripts = makeScripts();
  const sockPath = join(tmpdir(), `bun-s4-probe-sock2p-${randomHex(4)}.sock`);
  const strategyType = tracing.label === "otel-sdk" ? "otel" : "fields";

  const runSpan = tracing.startSpan("run", { parent: null, kind: "run-level", scopeId: null, agentId: null });
  const dispatchHandle = new Map<string, SpanHandle>();
  const promptHandle = new Map<string, SpanHandle>();
  const injected: Record<string, string> = {};
  const reportWait = new Map<string, () => void>();
  const responseWait = new Map<string, () => void>();
  const registered = new Map<string, () => void>();

  const serverSockByAgent = new Map<string, Socket>();

  const server = createServer((ssock) => {
    const buf = { s: "" };
    ssock.on("data", (chunk) => {
      buf.s += chunk.toString();
      let i;
      while ((i = buf.s.indexOf("\n")) >= 0) {
        const line = buf.s.slice(0, i);
        buf.s = buf.s.slice(i + 1);
        const env = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
        onInbound(ssock, env);
      }
    });
  });
  await new Promise<void>((res) => server.listen(sockPath, res));

  const sendToPeer = (agentId: string, env: Record<string, unknown>) => {
    serverSockByAgent.get(agentId)!.write(`${JSON.stringify(env)}\n`);
  };

  function onInbound(ssock: Socket, env: { type: string; payload: Record<string, unknown> }): void {
    const p = env.payload;
    if (env.type === "AGENT_REGISTER") {
      serverSockByAgent.set(String(p.agentId), ssock);
      registered.get(String(p.agentId))?.();
    } else if (env.type === "FINAL_REPORT") {
      const taskId = String(p.taskId);
      const dh = dispatchHandle.get(taskId);
      const fr = tracing.startSpan("final_report", { parent: dh ?? null, kind: "work-order-level", scopeId: taskId, agentId: null, operationId: taskId });
      tracing.endSpan(fr);
      if (dh) tracing.endSpan(dh);
      reportWait.get(taskId)?.();
    } else if (env.type === "RESPONSE") {
      const cid = String(p.correlationId);
      const ph = promptHandle.get(cid);
      if (ph) tracing.endSpan(ph);
      responseWait.get(cid)?.();
    }
  }

  // spawn peers
  const outFile: Record<string, string> = {};
  const procs: Promise<number>[] = [];
  const regWaits = ["peer-a", "peer-b"].map((a) => new Promise<void>((r) => registered.set(a, r)));
  for (const agentId of ["peer-a", "peer-b"]) {
    const out = join(tmpdir(), `bun-s4-peer-${agentId}-${randomHex(4)}.spans.json`);
    outFile[agentId] = out;
    const proc = Bun.spawn(
      ["bun", "peer.ts", "--sock", sockPath, "--agent", agentId, "--strategy", strategyType, "--script", JSON.stringify(scripts[agentId]), "--out", out],
      { cwd: import.meta.dir, stdout: "inherit", stderr: "inherit" },
    );
    procs.push(proc.exited);
  }
  await Promise.all(regWaits);

  // two concurrent work orders
  const woDone = facts.work_orders.map(({ taskId, agentId }) => {
    const done = new Promise<void>((r) => reportWait.set(taskId, r));
    const d = tracing.startSpan("dispatch", { parent: runSpan, kind: "work-order-level", scopeId: taskId, agentId: null, operationId: taskId });
    dispatchHandle.set(taskId, d);
    const env = { type: "WORK_ORDER", payload: { taskId, action: "do" } } as Record<string, unknown>;
    tracing.inject(env, d);
    injected[taskId] = String(env.traceparent ?? "");
    sendToPeer(agentId, env);
    return done;
  });
  await Promise.all(woDone);

  // one supervisor prompt
  {
    const cid = "prompt-1";
    const done = new Promise<void>((r) => responseWait.set(cid, r));
    const p = tracing.startSpan("prompt", { parent: runSpan, kind: "work-order-level", scopeId: cid, agentId: null, operationId: cid });
    promptHandle.set(cid, p);
    const env = { type: "PROMPT", payload: { agentId: "peer-a", correlationId: cid, text: "go" } } as Record<string, unknown>;
    tracing.inject(env, p);
    injected[cid] = String(env.traceparent ?? "");
    sendToPeer("peer-a", env);
    await done;
  }

  // finalize + validation
  const fz = tracing.startSpan("finalize", { parent: runSpan, kind: "run-level", scopeId: null, agentId: null });
  for (const { execution_id, command } of facts.validation_commands) {
    const v = tracing.startSpan("validation.command", { parent: fz, kind: "run-level", scopeId: null, agentId: null, operationId: execution_id, attrs: { command } });
    tracing.endSpan(v);
  }
  tracing.endSpan(fz);
  tracing.endSpan(runSpan);

  // tell peers to flush and exit
  for (const a of ["peer-a", "peer-b"]) sendToPeer(a, { type: "DONE", payload: {} });
  await Promise.all(procs);
  await tick();

  // merge supervisor spans + peer spans
  const peerSpans: SpanRecord[] = [];
  for (const agentId of ["peer-a", "peer-b"]) {
    const raw = await readFile(outFile[agentId], "utf8");
    peerSpans.push(...(JSON.parse(raw) as SpanRecord[]));
  }
  const spans = [...tracing.collect(), ...peerSpans];

  const prop = Object.keys(injected).map((key) => {
    const parsed = injected[key] ? parseTraceparent(injected[key]) : null;
    const turn = spans.find((s) => s.name === "peer.turn" && s.scope_id === key);
    const parent = turn?.parent_span_id ?? "";
    return { key, ok: parsed !== null && parsed.spanId === parent, parent };
  });

  server.close();
  for (const a of ["peer-a", "peer-b"]) await rm(outFile[a], { force: true });
  await rm(sockPath, { force: true });
  return { spans, facts, prop };
}

for (const Strat of [FieldsOnly, OtelSdk]) {
  const tracing = new Strat();
  const { spans, facts, prop } = await run2p(tracing);
  const failures = grade(spans, facts);
  console.log(`\n=== ${tracing.label} (two-process) ===`);
  console.log(`spans: ${spans.length}`);
  for (const c of prop) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.key}  parent=${c.parent.slice(0, 16)}`);
  console.log(`oracle A1-A10: ${failures.length === 0 ? "PASS (0 failures)" : `FAIL (${failures.length})`}`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(0);
