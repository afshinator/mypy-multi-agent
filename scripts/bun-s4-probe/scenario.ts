import { createServer, connect, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomHex, grade, parseTraceparent, type Facts, type SpanRecord } from "./core";
import { FieldsOnly, OtelSdk, type Tracing, type SpanHandle } from "./strategies";

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export interface PeerScript {
  workOrders: Record<string, [string, string][]>;
  prompts: Record<string, [string, string][]>;
}
export interface PropCheck { key: string; injected: string; extracted: string; ok: boolean }

export function makeFacts(): Facts {
  return {
    run_id: "run-1",
    work_orders: [{ taskId: "T-A", agentId: "peer-a" }, { taskId: "T-B", agentId: "peer-b" }],
    prompts: [{ correlationId: "prompt-1", from: "supervisor", to: "peer-a", sender_scope: "run" }],
    tool_executions: [
      { execution_id: "tool-A-1", scope_id: "T-A", agentId: "peer-a", tool: "read" },
      { execution_id: "tool-A-2", scope_id: "T-A", agentId: "peer-a", tool: "edit" },
      { execution_id: "tool-B-1", scope_id: "T-B", agentId: "peer-b", tool: "read" },
      { execution_id: "tool-B-2", scope_id: "T-B", agentId: "peer-b", tool: "bash" },
      { execution_id: "tool-A-3", scope_id: "prompt-1", agentId: "peer-a", tool: "read" },
    ],
    validation_commands: [
      { execution_id: "val-1", command: "bun run typecheck" },
      { execution_id: "val-2", command: "bun run test" },
    ],
    justified_links: [],
    concurrency: [{ a: "T-A", b: "T-B" }],
  };
}

export function makeScripts(): Record<string, PeerScript> {
  return {
    "peer-a": {
      workOrders: { "T-A": [["tool-A-1", "read"], ["tool-A-2", "edit"]] },
      prompts: { "prompt-1": [["tool-A-3", "read"]] },
    },
    "peer-b": { workOrders: { "T-B": [["tool-B-1", "read"], ["tool-B-2", "bash"]] }, prompts: {} },
  };
}

export async function runScenario(tracing: Tracing): Promise<{ spans: SpanRecord[]; facts: Facts; prop: PropCheck[] }> {
  const facts = makeFacts();
  const scripts = makeScripts();

  const sockPath = join(tmpdir(), `bun-s4-probe-sock-${randomHex(4)}.sock`);
  const runSpan = tracing.startSpan("run", { parent: null, kind: "run-level", scopeId: null, agentId: null });

  const dispatchHandle = new Map<string, SpanHandle>();
  const promptHandle = new Map<string, SpanHandle>();
  const injected: Record<string, string> = {};
  const extracted: Record<string, string> = {};

  const reportWait = new Map<string, () => void>();
  const responseWait = new Map<string, () => void>();
  const registered = new Map<string, () => void>();
  const waitReport = (taskId: string) => new Promise<void>((r) => reportWait.set(taskId, r));
  const waitResponse = (cid: string) => new Promise<void>((r) => responseWait.set(cid, r));
  const waitRegistered = (agentId: string) => new Promise<void>((r) => registered.set(agentId, r));

  const serverSockByAgent = new Map<string, Socket>(); // supervisor -> peer
  const clientByAgent = new Map<string, Socket>();     // peer -> supervisor

  const server = createServer((ssock) => {
    const buf = { s: "" };
    ssock.on("data", (chunk) => {
      buf.s += chunk.toString();
      let i;
      while ((i = buf.s.indexOf("\n")) >= 0) {
        const line = buf.s.slice(0, i);
        buf.s = buf.s.slice(i + 1);
        const env = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
        onSupervisorInbound(ssock, env);
      }
    });
  });
  await new Promise<void>((res) => server.listen(sockPath, res));

  const sendToPeer = (agentId: string, env: Record<string, unknown>) => {
    const s = serverSockByAgent.get(agentId);
    if (!s) throw new Error(`no server socket for ${agentId}`);
    s.write(`${JSON.stringify(env)}\n`);
  };
  const sendToSupervisor = (agentId: string, env: Record<string, unknown>) => {
    const s = clientByAgent.get(agentId);
    if (!s) throw new Error(`no client socket for ${agentId}`);
    s.write(`${JSON.stringify(env)}\n`);
  };

  function onSupervisorInbound(ssock: Socket, env: { type: string; payload: Record<string, unknown> }): void {
    const p = env.payload;
    if (env.type === "AGENT_REGISTER") {
      serverSockByAgent.set(String(p.agentId), ssock);
      registered.get(String(p.agentId))?.();
    } else if (env.type === "FINAL_REPORT") {
      const taskId = String(p.taskId);
      const dh = dispatchHandle.get(taskId);
      const fr = tracing.startSpan("final_report", {
        parent: dh ?? null, kind: "work-order-level", scopeId: taskId, agentId: null, operationId: taskId,
      });
      tracing.endSpan(fr);
      if (dh) tracing.endSpan(dh);
      reportWait.get(taskId)?.();
    } else if (env.type === "RESPONSE") {
      const correlationId = String(p.correlationId);
      const ph = promptHandle.get(correlationId);
      if (ph) tracing.endSpan(ph);
      responseWait.get(correlationId)?.();
    }
  }

  function onPeerInbound(agentId: string, script: PeerScript, env: { type: string; payload: Record<string, unknown> }): void {
    if (env.type === "WORK_ORDER") {
      const taskId = String(env.payload.taskId);
      const ext = tracing.extract(env);
      extracted[taskId] = ext?.id ?? "";
      const turn = tracing.startSpan("peer.turn", { parent: ext, kind: "work-order-level", scopeId: taskId, agentId });
      void (async () => {
        for (const [execId, tool] of script.workOrders[taskId] ?? []) {
          const t = tracing.startSpan("tool", {
            parent: turn, kind: "work-order-level", scopeId: taskId, agentId, operationId: execId, attrs: { tool },
          });
          await tick();
          tracing.endSpan(t);
        }
        tracing.endSpan(turn);
        sendToSupervisor(agentId, { type: "FINAL_REPORT", payload: { agentId, taskId, report: "done" } });
      })();
    } else if (env.type === "PROMPT") {
      const correlationId = String(env.payload.correlationId);
      const ext = tracing.extract(env);
      extracted[correlationId] = ext?.id ?? "";
      const turn = tracing.startSpan("peer.turn", { parent: ext, kind: "work-order-level", scopeId: correlationId, agentId });
      void (async () => {
        for (const [execId, tool] of script.prompts[correlationId] ?? []) {
          const t = tracing.startSpan("tool", {
            parent: turn, kind: "work-order-level", scopeId: correlationId, agentId, operationId: execId, attrs: { tool },
          });
          await tick();
          tracing.endSpan(t);
        }
        tracing.endSpan(turn);
        sendToSupervisor(agentId, { type: "RESPONSE", payload: { agentId, correlationId, text: "ok" } });
      })();
    }
  }

  const regWaits = ["peer-a", "peer-b"].map((a) => waitRegistered(a));
  for (const agentId of ["peer-a", "peer-b"]) {
    const client = connect(sockPath);
    clientByAgent.set(agentId, client);
    const buf = { s: "" };
    client.on("data", (chunk) => {
      buf.s += chunk.toString();
      let i;
      while ((i = buf.s.indexOf("\n")) >= 0) {
        const line = buf.s.slice(0, i);
        buf.s = buf.s.slice(i + 1);
        const env = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
        onPeerInbound(agentId, scripts[agentId], env);
      }
    });
    client.once("connect", () => client.write(`${JSON.stringify({ type: "AGENT_REGISTER", payload: { agentId } })}\n`));
  }
  await Promise.all(regWaits);

  const woDone = facts.work_orders.map(({ taskId, agentId }) => {
    const done = waitReport(taskId);
    const d = tracing.startSpan("dispatch", {
      parent: runSpan, kind: "work-order-level", scopeId: taskId, agentId: null, operationId: taskId,
    });
    dispatchHandle.set(taskId, d);
    const env = { type: "WORK_ORDER", payload: { taskId, action: "do" } } as Record<string, unknown>;
    tracing.inject(env, d);
    injected[taskId] = String(env.traceparent ?? "");
    sendToPeer(agentId, env);
    return done;
  });
  await Promise.all(woDone);

  {
    const correlationId = "prompt-1";
    const done = waitResponse(correlationId);
    const p = tracing.startSpan("prompt", {
      parent: runSpan, kind: "work-order-level", scopeId: correlationId, agentId: null, operationId: correlationId,
    });
    promptHandle.set(correlationId, p);
    const env = { type: "PROMPT", payload: { agentId: "peer-a", correlationId, text: "go" } } as Record<string, unknown>;
    tracing.inject(env, p);
    injected[correlationId] = String(env.traceparent ?? "");
    sendToPeer("peer-a", env);
    await done;
  }

  const fz = tracing.startSpan("finalize", { parent: runSpan, kind: "run-level", scopeId: null, agentId: null });
  for (const { execution_id, command } of facts.validation_commands) {
    const v = tracing.startSpan("validation.command", {
      parent: fz, kind: "run-level", scopeId: null, agentId: null, operationId: execution_id, attrs: { command },
    });
    tracing.endSpan(v);
  }
  tracing.endSpan(fz);
  tracing.endSpan(runSpan);

  await tick();

  const prop: PropCheck[] = Object.keys(injected).map((key) => {
    const parsed = injected[key] ? parseTraceparent(injected[key]) : null;
    return { key, injected: injected[key], extracted: extracted[key] ?? "", ok: parsed !== null && parsed.spanId === extracted[key] };
  });

  server.close();
  for (const c of clientByAgent.values()) c.destroy();
  await rm(sockPath, { force: true });
  return { spans: tracing.collect(), facts, prop };
}


