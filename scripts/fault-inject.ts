/**
 * Live fault-injection harness: one REAL peer process against a model that fails,
 * to see what reaches the bus. Answers the question three task runs could not:
 * does a transient provider error produce an agent-level retry (auto_retry_* →
 * HEARTBEAT.retry), does the peer recover, and does anything reach the supervisor?
 *
 * Usage: bun scripts/fault-inject.ts <provider/model> [timeoutSeconds]
 * Writes every received frame to stdout as it arrives.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlFramer } from "../src/bus/jsonl-framer";

const slug = process.argv[2];
const timeoutS = Number(process.argv[3] ?? 120);
if (!slug) {
  console.error("usage: bun scripts/fault-inject.ts <provider/model> [timeoutSeconds]");
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "fault-inject-"));
const busPath = join(dir, "run-details", "bus.sock");
await mkdir(join(dir, "run-details"), { recursive: true });
await writeFile(
  join(dir, "peer-config.json"),
  JSON.stringify({
    agentId: "probe",
    title: "Fault probe",
    model: slug,
    systemPrompt: "You are a probe. When asked, reply with the single word: PONG.",
    permissions: { read: true, edit: false, shell: false },
    maxCostUsd: 1,
    busPath,
    workspaceRoot: dir,
    retryPauseMs: 5000,
    retryMaxRetries: 3,
  } satisfies Record<string, unknown>),
);

const seen: string[] = [];
const retries: string[] = [];
let lastRetry: string | undefined;
let registered = false;
let socket: Socket | undefined;

const server = createServer((s) => {
  socket = s;
  const framer = new JsonlFramer();
  const started = Date.now();
  s.on("data", (chunk) => {
    for (const line of framer.push(chunk.toString())) {
      if (!line.trim()) continue;
      let env: Record<string, unknown>;
      try {
        env = JSON.parse(line);
      } catch {
        continue;
      }
      const type = String(env.type);
      const p = (env.payload ?? {}) as Record<string, unknown>;
      const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
      if (type === "HEARTBEAT") {
        // Only report beats that carry news: a retry in flight, or a busy edge.
        const retry = p.retry as { attempt: number; maxAttempts: number } | undefined;
        const key = retry ? `${retry.attempt}/${retry.maxAttempts}` : undefined;
        if (key !== lastRetry) {
          lastRetry = key;
          const note = key ? `RETRY ${key}` : "retry cleared (recovered or turn ended)";
          retries.push(`${t}s  ${note}`);
          console.log(`${t}s  HEARTBEAT.retry  ${note}`);
        }
        continue;
      }
      seen.push(type);
      console.log(`${t}s  ${type.padEnd(16)} ${JSON.stringify(p).slice(0, 220)}`);
      if (type === "AGENT_REGISTER" && !registered) {
        registered = true;
        // One prompt is enough: it exercises the retry path without a work order.
        const env2 = {
          id: "prompt-1",
          correlationId: "prompt-1",
          timestamp: Date.now(),
          sender: "supervisor",
          recipient: "probe",
          type: "PROMPT",
          payload: { agentId: "probe", text: "Reply with the single word: PONG" },
        };
        s.write(`${JSON.stringify(env2)}\n`);
        console.log(`${t}s  -> PROMPT sent`);
      }
      if (type === "RESPONSE" || type === "AGENT_UNUSABLE") {
        console.log(`\n=== reached the bus ===\n${JSON.stringify(env, null, 1).slice(0, 900)}`);
        finish();
      }
    }
  });
});

const child = spawn("bun", ["src/peer/peer-main.ts", "--config", join(dir, "peer-config.json")], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write(`   [peer stdout] ${d}`));
child.stderr.on("data", (d) => process.stdout.write(`   [peer stderr] ${d}`));

let done = false;
function finish(code = 0): void {
  if (done) return;
  done = true;
  console.log(
    `\n=== summary ===\nmodel: ${slug}\nframes: ${seen.join(", ") || "(none)"}\nretry transitions: ${retries.length}${retries.length ? `\n  ${retries.join("\n  ")}` : ""}`,
  );
  child.kill();
  socket?.destroy();
  server.close();
  setTimeout(() => process.exit(code), 100);
}

server.listen(busPath);
console.log(`bus: ${busPath}\nmodel: ${slug}\nwaiting up to ${timeoutS}s…\n`);
setTimeout(() => {
  console.log("\n(timeout — nothing reached the bus)");
  finish(1);
}, timeoutS * 1000);
