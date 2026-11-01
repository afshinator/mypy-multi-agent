import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  type ChildHandle,
  collectReply,
  extractPromptBlock,
  piArgs,
  runAgent,
} from "../../src/batch/agent";

/** A child that emits the given stdout/stderr text and then closes. */
function fakeChild(
  stdout: string,
  stderr: string,
  code: number,
): ChildHandle & { killed: string[] } {
  const emitter = new EventEmitter() as EventEmitter & ChildHandle & { killed: string[] };
  emitter.killed = [];
  emitter.stdout = Readable.from([stdout]);
  emitter.stderr = Readable.from([stderr]);
  emitter.kill = (signal?: string) => {
    emitter.killed.push(signal ?? "SIGTERM");
    return true;
  };
  setImmediate(() => emitter.emit("close", code));
  return emitter;
}

/** A child that never closes, so only the timeout can end the call. */
function stuckChild(): ChildHandle & { killed: string[] } {
  const emitter = new EventEmitter() as EventEmitter & ChildHandle & { killed: string[] };
  emitter.killed = [];
  emitter.stdout = Readable.from([]);
  emitter.stderr = Readable.from([]);
  emitter.kill = (signal?: string) => {
    emitter.killed.push(signal ?? "SIGTERM");
    return true;
  };
  return emitter;
}

/** A child that fails to spawn: it emits `error` and never closes. */
function errorChild(message: string): ChildHandle & { killed: string[] } {
  const emitter = new EventEmitter() as EventEmitter & ChildHandle & { killed: string[] };
  emitter.killed = [];
  emitter.stdout = Readable.from([]);
  emitter.stderr = Readable.from([]);
  emitter.kill = (signal?: string) => {
    emitter.killed.push(signal ?? "SIGTERM");
    return true;
  };
  setImmediate(() => emitter.emit("error", new Error(message)));
  return emitter;
}

const assistant = (text: string, extra = "{}") =>
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: { cost: { total: 0.002 } },
    },
    extra,
  });

describe("extractPromptBlock", () => {
  it("takes the fenced text block between its own delimiters", () => {
    const doc = "intro\n```text\nSITUATION\nbody\n```\nafter\n";
    expect(extractPromptBlock(doc)).toBe("SITUATION\nbody");
  });

  it("handles a four-backtick fence whose content contains fences", () => {
    const doc = "intro\n````text\nRun this:\n```json\n[]\n```\n````\nafter\n";
    expect(extractPromptBlock(doc)).toContain("```json");
    expect(extractPromptBlock(doc).endsWith("```")).toBe(true);
  });

  it("refuses a document with no fenced block", () => {
    expect(() => extractPromptBlock("no fence here")).toThrow(/fenced/);
  });
});

describe("piArgs", () => {
  it("runs one headless, read-only, extension-free call and puts the prompt last", () => {
    const args = piArgs({ prompt: "do it", model: "p/m", cwd: "/tmp", timeoutMs: 1000 });

    expect(args).toContain("-p");
    expect(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2)).toEqual([
      "--mode",
      "json",
    ]);
    expect(args).toContain("--no-session");
    expect(args).toContain("--no-extensions");
    expect(args[args.indexOf("--model") + 1]).toBe("p/m");
    expect(args.at(-1)).toBe("do it");
    // Tools are read-only: an unattended triage agent must not edit.
    expect(args.join(" ")).toContain("--tools read,bash,grep,find,ls");
  });
});

describe("collectReply", () => {
  it("returns the last assistant text and the summed cost", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "s" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: "hi" } }),
      assistant("first"),
      assistant("second"),
      JSON.stringify({ type: "agent_settled", aborted: false }),
    ].join("\n");

    expect(collectReply(jsonl)).toEqual({ text: "second", costUsd: 0.004 });
  });

  it("ignores streaming deltas and joins multiple text blocks", () => {
    const jsonl = [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "x" },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "toolCall", name: "read" },
            { type: "text", text: "b" },
          ],
          stopReason: "stop",
          usage: { cost: { total: 0.1 } },
        },
      }),
    ].join("\n");

    expect(collectReply(jsonl).text).toBe("a\n\nb");
  });

  it("refuses a reply that stopped with an error", () => {
    const jsonl = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "rate limited",
      },
    });
    expect(() => collectReply(jsonl)).toThrow(/rate limited/);
  });

  it("refuses a stream with no assistant message", () => {
    expect(() => collectReply(`${JSON.stringify({ type: "session", id: "s" })}\n`)).toThrow(
      /no reply/,
    );
  });

  it("refuses a malformed line instead of skipping it", () => {
    expect(() => collectReply(`${assistant("ok")}\n{not json}\n`)).toThrow(/not JSON/);
  });
});

describe("runAgent", () => {
  const input = { prompt: "do it", model: "p/m", cwd: "/tmp", timeoutMs: 5000 };

  it("returns the reply text", async () => {
    const run = await runAgent(input, () => fakeChild(assistant("done"), "", 0));
    expect(run.text).toBe("done");
  });

  it("fails on a nonzero exit and keeps stderr, which is where pi names the model", async () => {
    const spawn = () => fakeChild("", 'Error: Model "bogus/nope" not found.\n', 1);
    await expect(runAgent(input, spawn)).rejects.toThrow(/bogus\/nope/);
  });

  it("kills the child and refuses when the timeout expires", async () => {
    const child = stuckChild();
    await expect(runAgent({ ...input, timeoutMs: 20 }, () => child)).rejects.toThrow(/timed out/);
    expect(child.killed).toContain("SIGTERM");
  });

  it("rejects promptly when the binary cannot spawn, without waiting for the timeout", async () => {
    // A missing `pi` emits `error` (ENOENT) and never `close`; the failure must
    // name the binary and the system error, not the timeout.
    const start = Date.now();
    await expect(
      runAgent({ ...input, timeoutMs: 5000 }, () => errorChild("spawn pi ENOENT")),
    ).rejects.toThrow(/pi.*ENOENT/);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("keeps the spawn error as the verdict when a close arrives late", async () => {
    // A late close must neither turn the failure into a success nor replace the
    // spawn error (e.g. with collectReply's "no reply").
    const child = errorChild("spawn pi ENOENT") as unknown as ChildHandle & {
      emit: (e: string, v: unknown) => void;
    };
    const result = await runAgent({ ...input, timeoutMs: 5000 }, () => child).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/spawn pi ENOENT/);
    child.emit("close", 0);
    await new Promise((r) => setTimeout(r, 20));
    expect((result as Error).message).toMatch(/spawn pi ENOENT/);
  });
});
