// fallow-ignore-file unused-file
/**
 * Live proof for the peer file lock (issue #40): a real peer's write is held
 * while another agent owns the file's lock, and lands once the lock is released.
 *
 * Usage: bun scripts/lock-proof.ts      (costs one peer model turn)
 * Exits 1 on any failed check, so it can be used as a check, not just a demo.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionConfig } from "../src/contracts/session-schema";
import type { HerdrClient } from "../src/herdr/herdr-client";
import { toPeerConfig } from "../src/peer/peer-config";
import { Runtime } from "../src/runtime/runtime";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};

const MODEL = process.env.LOCK_PROOF_MODEL ?? "deepseek/deepseek-flash";
const agent = (id: string) => ({
  id,
  title: id,
  model: MODEL,
  permissions: { read: true, edit: true, shell: false },
  max_cost_usd: 0.5,
  max_tokens: 200000,
  system_prompt:
    "You are a verification peer. Do exactly what the work order says and report in one line.",
});
const config = parseSessionConfig({
  version: "1.1",
  session: {
    id: "lock-proof",
    max_cost_usd: 2,
    agent_stop_threshold_percent: 95,
    attester: "a1",
    peer_max_retries: 0,
  },
  ask: { title: "lock proof", description: "d", definition_of_done: ["dod"] },
  agents: [agent("holder"), agent("a1")],
});

const peerAgent = config.agents.find((a) => a.id === "a1");
if (peerAgent === undefined) throw new Error("a1 missing from the proof config");

const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) process.exitCode = 1;
};

const root = await mkdtemp(join(tmpdir(), "lock-proof-"));
const runDetails = join(root, "run-details");
const workspace = join(root, "workspace");
await mkdir(runDetails, { recursive: true });
await mkdir(workspace, { recursive: true });
const target = join(workspace, "shared.txt");
console.log(`run dir: ${root}`);

const rt = new Runtime(root, fakeHerdr, config);
await rt.start();
await writeFile(join(runDetails, "plan.md"), "plan\n");

// The competing agent: registers like a peer, then holds the file's lock.
const holder = connect(rt.bus.path);
await new Promise<void>((r) => holder.once("connect", () => r()));
const hsend = (env: unknown) => holder.write(`${JSON.stringify(env)}\n`);
hsend({
  id: "holder-register",
  timestamp: 0,
  sender: "holder",
  recipient: "supervisor",
  type: "AGENT_REGISTER",
  payload: {
    agentId: "holder",
    title: "holder",
    model: MODEL,
    permissions: { read: true, edit: true, shell: false },
    maxCostUsd: 1,
    systemPrompt: "s",
  },
});
await new Promise((r) => setTimeout(r, 200));
hsend({
  id: "holder-lock",
  timestamp: 0,
  sender: "holder",
  recipient: "supervisor",
  type: "LOCK_REQUEST",
  payload: { agentId: "holder", filePath: target, lockId: "hold-1" },
});
await new Promise((r) => setTimeout(r, 200));
check(rt.locks.ownerOf(target) === "holder", "the competing agent owns the lock");

// The real peer.
const cfgPath = join(runDetails, ".peer-a1.json");
await writeFile(
  cfgPath,
  JSON.stringify(
    toPeerConfig(
      peerAgent,
      rt.bus.path,
      workspace,
      { pauseMs: 0, maxRetries: 0, stallTimeoutMs: 300000 },
      runDetails,
    ),
  ),
);
const child = spawn("bun", ["src/peer/peer-main.ts", "--config", cfgPath], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, HERDR_PANE_ID: "", HERDR_ENV: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let peerOut = "";
child.stdout.on("data", (d) => (peerOut += d));
child.stderr.on("data", (d) => (peerOut += d));

const waitFor = async (fn: () => boolean, ms: number, label: string): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}\n--- peer ---\n${peerOut}`);
};

try {
  await waitFor(() => rt.registry.has("a1"), 30_000, "a1 registration");
  rt.dispatch("a1", {
    taskId: "t1",
    action:
      "Use the write tool to create the file shared.txt in your working directory with exactly the text LOCK_PROOF. Do not use any other tool.",
    contextFiles: [],
    constraints: [],
    localDoD: "shared.txt exists with LOCK_PROOF",
  });

  // Long enough for the peer to try the write and block on the held lock.
  await new Promise((r) => setTimeout(r, 4000));
  check(!existsSync(target), "the peer's write is held while the lock is owned");
  check(rt.locks.ownerOf(target) === "holder", "the lock is still the competitor's");

  hsend({
    id: "holder-release",
    timestamp: 0,
    sender: "holder",
    recipient: "supervisor",
    type: "LOCK_RELEASED",
    payload: { agentId: "holder", filePath: target },
  });

  await waitFor(() => rt.reconciliation.hasReport("a1"), 120_000, "a1 FINAL_REPORT");
  await new Promise((r) => setTimeout(r, 300));
  check(existsSync(target), "the write lands after the lock is released");
  const content = existsSync(target) ? (await readFile(target, "utf8")).trim() : "";
  check(content === "LOCK_PROOF", `file content is LOCK_PROOF (got ${JSON.stringify(content)})`);

  const conversation = await readFile(join(runDetails, "conversation.jsonl"), "utf8");
  check(conversation.includes('"LOCK_REQUEST"'), "the peer sent LOCK_REQUEST");
  check(conversation.includes('"LOCK_ACQUIRED"'), "the runtime granted LOCK_ACQUIRED");
} finally {
  child.kill();
  holder.destroy();
  await rt.stop().catch(() => {});
}

console.log(process.exitCode === 1 ? "LOCK PROOF FAILED" : "LOCK PROOF OK");
