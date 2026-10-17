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
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlFramer } from "../src/bus/jsonl-framer";
import { failFirstChat, stripHopHeaders } from "./one-shot-proxy";

const slug = process.argv[2];
const timeoutS = Number(process.argv[3] ?? 120);
// Escape hatch: the old permanent-failure harness, no proxy, no throwaway agent dir.
const noShim = process.argv.includes("--no-shim");
if (!slug) {
  console.error("usage: bun scripts/fault-inject.ts <provider/model> [timeoutSeconds] [--no-shim]");
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "fault-inject-"));
const busPath = join(dir, "run-details", "bus.sock");
await mkdir(join(dir, "run-details"), { recursive: true });

/** Response headers a proxy must not copy verbatim; Node re-frames the body. */
function forward(req: IncomingMessage, res: ServerResponse, upstream: string): void {
  const headers = { ...req.headers, host: "openrouter.ai", "accept-encoding": "identity" };
  const out = httpsRequest(
    new URL(upstream + (req.url ?? "/")),
    { method: req.method, headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, stripHopHeaders(r.headers));
      r.pipe(res);
    },
  );
  out.on("error", (err) => {
    res.writeHead(502);
    res.end(String(err));
  });
  req.pipe(out);
}

/**
 * One-shot failure shim (issue #5): the FIRST chat-completion request the peer
 * makes gets a retryable HTTP 500; every later request is streamed to the real
 * upstream with the peer's own Authorization header. A one-shot failure inside one
 * pi `prompt()` is what proves the agent-level retry RECOVERS, not just that it
 * fires (the old harness used a permanently failing model).
 */
async function startShim(): Promise<{ agentDir: string; close: () => void }> {
  // Origin only: the peer's request path already carries the /api/v1 prefix.
  const upstream = "https://openrouter.ai";
  let chatCalls = 0;
  const proxy = createHttpServer((req, res) => {
    const isChat = (req.url ?? "").includes("/chat/completions");
    chatCalls += isChat ? 1 : 0;
    console.log(`[proxy] call#${chatCalls} ${req.method} ${req.url}`);
    if (failFirstChat(isChat, chatCalls)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "fault-inject: 500 simulated upstream failure" } }),
      );
      return;
    }
    forward(req, res, upstream);
  });
  await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
  const port = (proxy.address() as { port: number }).port;

  // A throwaway agent dir is the only supported seam that lands BEFORE the peer
  // resolves its model (ModelRuntime.create reads models.json first).
  const liveDir = join(homedir(), ".pi", "agent");
  const agentDir = join(dir, "agent");
  await mkdir(agentDir, { recursive: true });
  const readJson = async (name: string): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(join(liveDir, name), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const models = await readJson("models.json");
  const providers = (models.providers ?? {}) as Record<string, unknown>;
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      ...models,
      providers: {
        ...providers,
        openrouter: {
          ...(providers.openrouter as object),
          baseUrl: `http://127.0.0.1:${port}/api/v1`,
        },
      },
    }),
  );
  // Same retry cadence the incident evidence measured (15/30/60s).
  const settings = await readJson("settings.json");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ ...settings, retry: { enabled: true, baseDelayMs: 15000, maxRetries: 3 } }),
  );
  // The real credential rides through untouched; the proxy never reads it.
  await symlink(join(liveDir, "auth.json"), join(agentDir, "auth.json"));
  return { agentDir, close: () => proxy.close() };
}

const shim = noShim ? undefined : await startShim();
if (shim) console.log(`[shim] one-shot 500 -> ${shim.agentDir}`);

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
    // 0 so a second *harness* turn can never be mistaken for pi's agent-level retry.
    retryMaxRetries: 0,
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
  env: shim ? { ...process.env, PI_CODING_AGENT_DIR: shim.agentDir } : process.env,
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
  shim?.close();
  setTimeout(() => process.exit(code), 100);
}

server.listen(busPath);
console.log(`bus: ${busPath}\nmodel: ${slug}\nwaiting up to ${timeoutS}s…\n`);
setTimeout(() => {
  console.log("\n(timeout — nothing reached the bus)");
  finish(1);
}, timeoutS * 1000);
