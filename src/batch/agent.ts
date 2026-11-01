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
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string }) => ChildHandle;

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
  const child = spawnFn("pi", piArgs(input), { cwd: input.cwd });

  return await new Promise<AgentRun>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // A pi that ignores SIGTERM would keep spending; escalate without holding the call.
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      settle(() => reject(new Error(`pi timed out after ${input.timeoutMs} ms`)));
    }, input.timeoutMs);

    // A `pi` that cannot spawn at all (not installed, not on PATH, not
    // executable) emits `error` with ENOENT and never `close`; without a
    // handler the only exit is the timeout timer, and the batch blames the
    // model for a missing binary (#200).
    child.on("error", (err) => {
      clearTimeout(timer);
      settle(() =>
        reject(
          new Error(
            `pi could not start (${err.message}); check that the binary is installed and on PATH`,
          ),
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) {
        settle(() =>
          reject(
            new Error(`pi exited ${String(code)}: ${stderr.trim().slice(0, 400) || "no stderr"}`),
          ),
        );
        return;
      }
      try {
        settle(() => resolve(collectReply(stdout)));
      } catch (err) {
        settle(() => reject(err));
      }
    });
  });
}
