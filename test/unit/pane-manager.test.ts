import { describe, expect, it } from "vitest";
import { PaneManager } from "../../src/herdr/pane-manager";
import type { CreatePaneOpts, HerdrClient, PaneMetadata } from "../../src/herdr/herdr-client";

class FakeClient implements HerdrClient {
  created: (CreatePaneOpts | undefined)[] = [];
  commands: [string, string][] = [];
  closed: string[] = [];
  private counter = 0;

  async createPane(opts?: CreatePaneOpts): Promise<string> {
    this.created.push(opts);
    return `pane-${++this.counter}`;
  }
  async runCommand(paneId: string, command: string): Promise<void> {
    this.commands.push([paneId, command]);
  }
  async reportMetadata(_paneId: string, _source: string, _meta: PaneMetadata): Promise<void> {}
  async closePane(paneId: string): Promise<void> {
    this.closed.push(paneId);
  }
}

describe("PaneManager", () => {
  it("spawn maps agent to pane and runs the command", async () => {
    const c = new FakeClient();
    const m = new PaneManager(c);
    const paneId = await m.spawn("a1", "node peer.ts");
    expect(paneId).toBe("pane-1");
    expect(m.paneOf("a1")).toBe("pane-1");
    expect(c.commands).toEqual([["pane-1", "node peer.ts"]]);
  });

  it("terminate closes the pane and unmaps the agent", async () => {
    const c = new FakeClient();
    const m = new PaneManager(c);
    await m.spawn("a1", "x");
    await m.terminate("a1");
    expect(m.paneOf("a1")).toBeUndefined();
    expect(c.closed).toEqual(["pane-1"]);
  });

  it("terminateAll closes every owned pane", async () => {
    const c = new FakeClient();
    const m = new PaneManager(c);
    await m.spawn("a", "x");
    await m.spawn("b", "x");
    await m.terminateAll();
    expect(c.closed).toEqual(["pane-1", "pane-2"]);
  });

  it("spawnAll tiles peers into a balanced grid", async () => {
    const c = new FakeClient();
    const m = new PaneManager(c, "sup-pane");
    await m.spawnAll([
      { agentId: "a", command: "cmd-a" },
      { agentId: "b", command: "cmd-b" },
      { agentId: "c", command: "cmd-c" },
    ]);
    expect(c.created).toEqual([
      { paneId: "sup-pane", direction: "down", ratio: 0.5 },
      { paneId: "sup-pane", direction: "right", ratio: 0.5 },
      { paneId: "pane-1", direction: "right", ratio: 0.5 },
    ]);
    expect(c.commands).toEqual([
      ["pane-2", "cmd-a"],
      ["pane-1", "cmd-b"],
      ["pane-3", "cmd-c"],
    ]);
    expect(m.paneOf("a")).toBe("pane-2");
    expect(m.paneOf("b")).toBe("pane-1");
    expect(m.paneOf("c")).toBe("pane-3");
  });

  it("spawnAll passes cwd to peer panes", async () => {
    const c = new FakeClient();
    const m = new PaneManager(c, "sup-pane");
    await m.spawnAll([{ agentId: "a", command: "cmd-a" }], "/ask");
    expect(c.created).toEqual([{ paneId: "sup-pane", direction: "right", ratio: 0.5, cwd: "/ask" }]);
  });

  it("spawnAll falls back to right splits without a supervisor pane id", async () => {
    const c = new FakeClient();
    const m = new PaneManager(c);
    await m.spawnAll([
      { agentId: "a", command: "cmd-a" },
      { agentId: "b", command: "cmd-b" },
    ]);
    expect(c.created).toEqual([{ direction: "right" }, { direction: "right" }]);
    expect(c.commands.map(([, cmd]) => cmd)).toEqual(["cmd-a", "cmd-b"]);
  });
});
