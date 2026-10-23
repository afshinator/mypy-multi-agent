/**
 * Unit tests for the peer launcher's mapping onto the pane manager.
 */
import { describe, expect, it } from "vitest";
import type { CreatePaneOpts, HerdrClient, PaneMetadata } from "../../src/herdr/herdr-client";
import { HerdrPeerLauncher } from "../../src/peer/peer-launcher";

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

describe("HerdrPeerLauncher", () => {
  it("launchAll forwards specs and cwd to the pane grid", async () => {
    const c = new FakeClient();
    const launcher = new HerdrPeerLauncher(c, "sup-pane");
    await launcher.launchAll(
      [
        { agentId: "a", command: "cmd-a" },
        { agentId: "b", command: "cmd-b" },
        { agentId: "c", command: "cmd-c" },
      ],
      "/ask",
    );
    expect(c.created).toEqual([
      { paneId: "sup-pane", direction: "down", ratio: 0.5, cwd: "/ask" },
      { paneId: "sup-pane", direction: "right", ratio: 0.5, cwd: "/ask" },
      { paneId: "pane-1", direction: "right", ratio: 0.5, cwd: "/ask" },
    ]);
    expect(c.commands).toEqual([
      ["pane-2", "cmd-a"],
      ["pane-1", "cmd-b"],
      ["pane-3", "cmd-c"],
    ]);
  });

  it("respawn re-runs the command in the existing pane without creating one", async () => {
    const c = new FakeClient();
    const launcher = new HerdrPeerLauncher(c, "sup-pane");
    await launcher.launchAll([{ agentId: "a", command: "old" }]);
    await launcher.respawn("a", "new");
    expect(c.created).toHaveLength(1);
    expect(c.commands).toEqual([
      ["pane-1", "old"],
      ["pane-1", "new"],
    ]);
  });

  it("terminate closes the tracked pane", async () => {
    const c = new FakeClient();
    const launcher = new HerdrPeerLauncher(c, "sup-pane");
    await launcher.launchAll([{ agentId: "a", command: "cmd-a" }]);
    await launcher.terminate("a");
    expect(c.closed).toEqual(["pane-1"]);
  });

  it("terminateAll closes every tracked pane", async () => {
    const c = new FakeClient();
    const launcher = new HerdrPeerLauncher(c, "sup-pane");
    await launcher.launchAll([
      { agentId: "a", command: "cmd-a" },
      { agentId: "b", command: "cmd-b" },
    ]);
    await launcher.terminateAll();
    expect(c.closed).toEqual(["pane-2", "pane-1"]);
  });
});
