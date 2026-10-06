import { describe, expect, it } from "vitest";
import { PaneManager } from "../../src/herdr/pane-manager";
import type { HerdrClient, PaneMetadata } from "../../src/herdr/herdr-client";

class FakeClient implements HerdrClient {
  created: ({ direction?: string; cwd?: string } | undefined)[] = [];
  commands: [string, string][] = [];
  closed: string[] = [];
  private counter = 0;

  async createPane(opts?: { direction?: string; cwd?: string }): Promise<string> {
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

  it("terminate of an unknown agent is a no-op", async () => {
    const c = new FakeClient();
    const m = new PaneManager(c);
    await m.terminate("nope");
    expect(c.closed).toEqual([]);
  });
});
