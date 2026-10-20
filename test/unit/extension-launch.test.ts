/**
 * Characterization tests for the /mypi-multi-agent launch path (issue #33),
 * extended for --init (#58) and the never-scaffolds run command (#59).
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
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

  it("--init creates the config and a keys-only starter, then reports without overwriting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "init-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const { command } = fakePi();
      const { ctx, notify } = ctxWith();
      await command().handler("--init", ctx);

      const config = await readFile(join(dir, "mypi-multi-agent.yaml"), "utf8");
      expect(config).toContain("version: 1");
      expect(config).toContain("mypi-tasks");
      expect(config).toContain("First entry is the write target");

      const starterPath = join(dir, "mypi-tasks", "task", "session.yaml");
      expect(existsSync(starterPath)).toBe(true);
      const starter = await readFile(starterPath, "utf8");
      expect(starter).toContain("version:");
      expect(starter).toContain("session:");
      expect(starter).toContain("ask:");
      expect(starter).toContain("agents:");
      expect(starter).toContain("#");
      expect(starter).not.toContain("deepseek");
      expect(starter).not.toContain("my-task");
      // Keys-only: every field parses to null, so it is a form, not a filled config.
      const parsed = parseYaml(starter) as {
        version: unknown;
        session: { id: unknown };
        ask: { title: unknown };
        agents: [{ model: unknown }];
      };
      expect(parsed.version).toBeNull();
      expect(parsed.session.id).toBeNull();
      expect(parsed.ask.title).toBeNull();
      expect(parsed.agents[0].model).toBeNull();

      // Re-init must report the existing dirs and never clobber either file.
      await writeFile(join(dir, "mypi-multi-agent.yaml"), `${config}# marker\n`);
      await writeFile(starterPath, "custom starter\n");
      notify.mockClear();
      await command().handler("--init", ctx);
      expect(notify).toHaveBeenCalledWith("already configured: taskDirs=[mypi-tasks]", "info");
      expect(await readFile(join(dir, "mypi-multi-agent.yaml"), "utf8")).toContain("# marker");
      expect(await readFile(starterPath, "utf8")).toBe("custom starter\n");
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("--init propagates a non-EEXIST starter write failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "init-fail-"));
    const cwd = process.cwd();
    const taskDir = join(dir, "mypi-tasks", "task");
    try {
      process.chdir(dir);
      // A read-only starter parent makes the starter write fail with EACCES (not
      // EEXIST), which must propagate instead of being swallowed.
      await mkdir(taskDir, { recursive: true });
      await chmod(taskDir, 0o555);
      const { command } = fakePi();
      const { ctx, notify } = ctxWith();
      await command().handler("--init", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("could not initialize"), "error");
      expect(existsSync(join(dir, "mypi-multi-agent.yaml"))).toBe(true);
    } finally {
      await chmod(taskDir, 0o755).catch(() => {});
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("run with no config errors and creates no files", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "test-pane";
    const dir = await mkdtemp(join(tmpdir(), "launch-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const { command } = fakePi();
      const { ctx, notify } = ctxWith();
      await command().handler("smoke", ctx);
      expect(notify).toHaveBeenCalledWith(
        "project not configured to run mypi-multi-agent — run /mypi-multi-agent --init",
        "error",
      );
      expect(existsSync(join(dir, "mypi-multi-agent.yaml"))).toBe(false);
      expect(existsSync(join(dir, "mypi-tasks"))).toBe(false);
      expect(existsSync(join(dir, ".mypi"))).toBe(false);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("run with a missing named task errors and creates no files", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "test-pane";
    const dir = await mkdtemp(join(tmpdir(), "launch-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      await writeFile(
        join(dir, "mypi-multi-agent.yaml"),
        "version: 1\ntaskDirs:\n  - mypi-tasks\n",
      );
      const { command } = fakePi();
      const { ctx, notify } = ctxWith();
      await command().handler("missing", ctx);
      expect(notify).toHaveBeenCalledWith("task 'missing' not found under taskDirs", "error");
      expect(existsSync(join(dir, "mypi-tasks"))).toBe(false);
      expect(existsSync(join(dir, "mypi-tasks", "missing"))).toBe(false);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
