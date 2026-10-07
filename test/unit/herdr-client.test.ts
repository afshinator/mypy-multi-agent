/**
 * Unit tests for the herdr client module.
 */
import { describe, expect, it } from "vitest";
import { HerdrCliClient } from "../../src/herdr/herdr-client";

describe("HerdrCliClient", () => {
  it("reportMetadata builds canonical state tokens", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    const c = new HerdrCliClient(exec);
    await c.reportMetadata("w1:p1", "mypi", {
      state: "WORKING",
      cost: "0.41",
      tokens: "34210",
      title: "Task: X",
    });
    expect(calls[0]).toEqual([
      "pane", "report-metadata", "w1:p1", "--source", "mypi",
      "--token", "state=WORKING", "--token", "cost=0.41", "--token", "tokens=34210",
      "--title", "Task: X",
    ]);
  });

  it("reportMetadata includes role, model, and display-agent", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    const c = new HerdrCliClient(exec);
    await c.reportMetadata("w1:p1", "peer", { state: "WORKING", role: "Developer A", model: "commandcode/z-ai/glm-5.3-flash", displayAgent: "Developer A · commandcode/z-ai/glm-5.3-flash" });
    expect(calls[0]).toEqual([
      "pane", "report-metadata", "w1:p1", "--source", "peer",
      "--token", "state=WORKING", "--token", "role=Developer A", "--token", "model=commandcode/z-ai/glm-5.3-flash",
      "--display-agent", "Developer A · commandcode/z-ai/glm-5.3-flash",
    ]);
  });

  it("reportMetadata omits unset fields", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    const c = new HerdrCliClient(exec);
    await c.reportMetadata("w1:p1", "mypi", { state: "WORKING" });
    expect(calls[0]).toEqual(["pane", "report-metadata", "w1:p1", "--source", "mypi", "--token", "state=WORKING"]);
  });

  it("createPane parses the pane id from JSON", async () => {
    const exec = async () => JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
    const c = new HerdrCliClient(exec);
    expect(await c.createPane({ direction: "right", cwd: "/x" })).toBe("w1:p2");
  });

  it("createPane passes paneId and ratio", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
    };
    const c = new HerdrCliClient(exec);
    await c.createPane({ paneId: "w1:p1", direction: "down", ratio: 0.5 });
    expect(calls[0]).toEqual(["pane", "split", "w1:p1", "--direction", "down", "--ratio", "0.5", "--no-focus"]);
  });

  it("createPane defaults to --current when no paneId", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
    };
    const c = new HerdrCliClient(exec);
    await c.createPane({ direction: "right" });
    expect(calls[0]).toEqual(["pane", "split", "--current", "--direction", "right", "--no-focus"]);
  });

  it("runCommand and closePane build the right argv", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    const c = new HerdrCliClient(exec);
    await c.runCommand("w1:p2", "node peer.ts");
    await c.closePane("w1:p2");
    expect(calls[0]).toEqual(["pane", "run", "w1:p2", "node peer.ts"]);
    expect(calls[1]).toEqual(["pane", "close", "w1:p2"]);
  });
});
