/** Standalone peer process for the two-process probe. Minted spans are written
 * to --out so the supervisor can merge and grade them. No shared state with the
 * supervisor process. */
import { connect } from "node:net";
import { writeFile } from "node:fs/promises";
import { FieldsOnly, OtelSdk, type Tracing } from "./strategies";

const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const sock = arg("--sock")!;
const agentId = arg("--agent")!;
const strategy = arg("--strategy")!;
const script = JSON.parse(arg("--script")!) as {
  workOrders: Record<string, [string, string][]>;
  prompts: Record<string, [string, string][]>;
};
const out = arg("--out")!;

const tracing: Tracing = strategy === "otel" ? new OtelSdk() : new FieldsOnly();

const client = connect(sock);
client.on("connect", () => client.write(`${JSON.stringify({ type: "AGENT_REGISTER", payload: { agentId } })}\n`));

let buf = "";
client.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const env = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
    void handle(env);
  }
});

async function handle(env: { type: string; payload: Record<string, unknown> }): Promise<void> {
  const p = env.payload;
  if (env.type === "WORK_ORDER") {
    const taskId = String(p.taskId);
    const ext = tracing.extract(env);
    const turn = tracing.startSpan("peer.turn", { parent: ext, kind: "work-order-level", scopeId: taskId, agentId });
    for (const [execId, tool] of script.workOrders[taskId] ?? []) {
      const t = tracing.startSpan("tool", { parent: turn, kind: "work-order-level", scopeId: taskId, agentId, operationId: execId, attrs: { tool } });
      tracing.endSpan(t);
    }
    tracing.endSpan(turn);
    client.write(`${JSON.stringify({ type: "FINAL_REPORT", payload: { agentId, taskId, report: "done" } })}\n`);
  } else if (env.type === "PROMPT") {
    const cid = String(p.correlationId);
    const ext = tracing.extract(env);
    const turn = tracing.startSpan("peer.turn", { parent: ext, kind: "work-order-level", scopeId: cid, agentId });
    for (const [execId, tool] of script.prompts[cid] ?? []) {
      const t = tracing.startSpan("tool", { parent: turn, kind: "work-order-level", scopeId: cid, agentId, operationId: execId, attrs: { tool } });
      tracing.endSpan(t);
    }
    tracing.endSpan(turn);
    client.write(`${JSON.stringify({ type: "RESPONSE", payload: { agentId, correlationId: cid, text: "ok" } })}\n`);
  } else if (env.type === "DONE") {
    await writeFile(out, JSON.stringify(tracing.collect()));
    process.exit(0);
  }
}
