/**
 * One headless agent call: a fenced prompt document, an argv, and a JSONL reply.
 *
 * `pi -p --mode json` is one-shot and works (measured: exit 0, 2.8 s, $0.000035), but two
 * properties decide this module's shape. The stream carries the whole `agent_end` with
 * every message, so a triage reply is tens of megabytes — `execFile`'s `maxBuffer` would
 * fail it, and `readline` is not safe on this framing (docs/json.md). And an unavailable
 * model exits 1 with the reason on stderr and nothing on stdout, so a refusal must not be
 * read as an empty reply.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { agentConfigDir, sandboxAvailable, sandboxedAgent, sandboxProfile } from "./sandbox";

export interface AgentInput {
  prompt: string;
  model: string;
  cwd: string;
  timeoutMs: number;
  /** Replaces the default read-only set. */
  tools?: string;
}

export interface AgentRun {
  text: string;
  costUsd: number;
}

export interface ChildHandle {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnOptions {
  cwd: string;
  /** `ignore` for stdin: pi reads it and waits for EOF, so an inherited pipe hangs the call. */
  stdio: ["ignore", "pipe", "pipe"];
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildHandle;

const DEFAULT_TOOLS = "read,bash,grep,find,ls";

/** The fenced block a prompt document wraps its prompt in, fences included. */
export function extractPromptBlock(docText: string): string {
  const lines = docText.split("\n");
  const open = lines.findIndex((line) => /^`{3,}text\s*$/.test(line));
  if (open === -1) throw new Error("prompt document has no ```text fenced block");
  const fence = lines[open]?.match(/^`+/)?.[0] ?? "```";
  const close = lines.findIndex((line, i) => i > open && line.trim() === fence);
  if (close === -1) throw new Error(`prompt document's ${fence} fence is not closed`);
  return lines.slice(open + 1, close).join("\n");
}

export function piArgs(input: AgentInput): string[] {
  return [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--tools",
    input.tools ?? DEFAULT_TOOLS,
    "--model",
    input.model,
    input.prompt,
  ];
}

interface StreamRecord {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
    usage?: { cost?: { total?: number } };
  };
}

/** Reply text and cost from the JSONL stream; the last assistant message is authoritative. */
export function collectReply(jsonl: string): AgentRun {
  let text: string | undefined;
  let costUsd = 0;

  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let record: StreamRecord;
    try {
      record = JSON.parse(line) as StreamRecord;
    } catch {
      throw new Error(`pi stream line is not JSON: ${line.slice(0, 120)}`);
    }
    if (record.type !== "message_end" || record.message?.role !== "assistant") continue;

    const message = record.message;
    if (message.stopReason === "error") {
      throw new Error(`pi reply stopped with an error: ${message.errorMessage ?? "no message"}`);
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    const parts = blocks
      .filter((block): block is { type: string; text: string } => {
        const b = block as { type?: string; text?: unknown };
        return b.type === "text" && typeof b.text === "string";
      })
      .map((block) => block.text);
    text = parts.join("\n\n");
    costUsd += message.usage?.cost?.total ?? 0;
  }

  if (text === undefined)
    throw new Error("pi produced no reply (no assistant message in the stream)");
  return { text, costUsd };
}

export async function runAgent(
  input: AgentInput,
  spawnFn: SpawnFn = spawn as unknown as SpawnFn,
): Promise<AgentRun> {
  // The bash tool runs commands a model wrote from untrusted ticket text, so the child and
  // everything it spawns are confined by a sandbox (#487). Without `sandbox-exec` the spawn is
  // unchanged, and so is the config dir: pi must keep its own on a machine that cannot sandbox.
  const configDir = sandboxAvailable() ? agentConfigDir() : undefined;
  const argv =
    configDir === undefined
      ? ["pi", ...piArgs(input)]
      : sandboxedAgent(
          piArgs(input),
          sandboxProfile({ clone: input.cwd, configDir, home: homedir() }),
        );
  const command = argv[0] ?? "pi";
  const args = argv.slice(1);
  const child = spawnFn(command, args, {
    cwd: input.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    ...(configDir === undefined ? {} : { env: { ...process.env, PI_CODING_AGENT_DIR: configDir } }),
  });
  const cleanup = () => {
    if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
  };

  return await new Promise<AgentRun>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };

    timer = setTimeout(() => {
      child.kill("SIGTERM");
      // A pi that ignores SIGTERM would keep spending; escalate without holding the call.
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      settle(() => reject(new Error(`pi timed out after ${input.timeoutMs} ms`)));
    }, input.timeoutMs);

    // A binary that cannot start emits `error`, and `close -2` only afterwards: without this
    // the call waits out the timeout and blames the model (#200).
    child.on("error", (error) => {
      settle(() => {
        cleanup();
        reject(new Error(`pi failed to start: ${error.message}`));
      });
    });

    child.on("close", (code) => {
      cleanup();
      settle(() => {
        if (code !== 0) {
          reject(
            new Error(`pi exited ${String(code)}: ${stderr.trim().slice(0, 400) || "no stderr"}`),
          );
          return;
        }
        try {
          resolve(collectReply(stdout));
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}
