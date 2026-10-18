/**
 * Characterization tests for the /mypi-multi-agent launch path (issue #33).
 * The handler used to bury this behind 140 lines; the refactor only moved code,
 * so these pin the behaviour that must not change while the split lands.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import mypi from "../../src/pi/extension";

interface Command {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Minimal extension host: captures the registered command and tools. */
function fakePi(): { pi: ExtensionAPI; command: () => Command; sent: () => unknown[] } {
  const commands = new Map<string, Command>();
  const sent: unknown[] = [];
  const pi = {
    on: vi.fn(),
    registerCommand: (name: string, opts: Command) => commands.set(name, opts),
    registerTool: vi.fn(),
    sendUserMessage: (msg: string) => sent.push(msg),
    setModel: vi.fn(),
  } as unknown as ExtensionAPI;
  mypi(pi);
  return {
    pi,
    command: () => {
      const cmd = commands.get("mypi-multi-agent");
      if (cmd === undefined) throw new Error("command not registered");
      return cmd;
    },
    sent: () => sent,
  };
}

const ctxWith = () => {
  const notify = vi.fn();
  return { ctx: { ui: { notify }, modelRegistry: {}, sessionManager: {} }, notify };
};

const savedEnv = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
afterEach(() => {
  if (savedEnv.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = savedEnv.HERDR_ENV;
  if (savedEnv.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = savedEnv.HERDR_PANE_ID;
});

describe("/mypi-multi-agent launch", () => {
  it("refuses to start outside a herdr pane", async () => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    const { command } = fakePi();
    const { ctx, notify } = ctxWith();
    await command().handler("", ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("run inside a herdr pane first"),
      "error",
    );
  });

  it("scaffolds a portable session when the named task has none", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "test-pane";
    const dir = await mkdtemp(join(tmpdir(), "launch-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const { command } = fakePi();
      const { ctx, notify } = ctxWith();
      await command().handler("smoke", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("scaffolded"), "info");
      expect(existsSync(join(dir, ".mypi", "smoke", "session.yaml"))).toBe(true);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
