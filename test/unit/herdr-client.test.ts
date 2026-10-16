/**
 * Unit tests for the herdr client module.
 */
import { describe, expect, it } from "vitest";
import { HerdrCliClient } from "../../src/herdr/herdr-client";

describe("HerdrCliClient", () => {
  it("reportMetadata emits title", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    const c = new HerdrCliClient(exec);
    await c.reportMetadata("w1:p1", "mypi", {
      title: "dev_a · WORKING · Developer A · model",
    });
    expect(calls[0]).toEqual([
      "pane",
      "report-metadata",
      "w1:p1",
      "--source",
      "mypi",
      "--title",
      "dev_a · WORKING · Developer A · model",
    ]);
  });

  it("reportMetadata omits unset fields", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    const c = new HerdrCliClient(exec);
    await c.reportMetadata("w1:p1", "mypi", { title: "x" });
    expect(calls[0]).toEqual([
      "pane",
      "report-metadata",
      "w1:p1",
      "--source",
      "mypi",
      "--title",
      "x",
    ]);
  });

  it("reportMetadata emits sorted --token args after --title", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    const c = new HerdrCliClient(exec);
    await c.reportMetadata("w1:p1", "mypi", {
      title: "dev_a · WORKING 12s",
      tokens: { progress: "12s", cost: "0.41", state: "WORKING", model: "m" },
    });
    expect(calls[0]).toEqual([
      "pane",
      "report-metadata",
      "w1:p1",
      "--source",
      "mypi",
      "--title",
      "dev_a · WORKING 12s",
      "--token",
      "cost=0.41",
      "--token",
      "model=m",
      "--token",
      "progress=12s",
      "--token",
      "state=WORKING",
    ]);
  });

  it("reportMetadata omits --token when tokens are unset", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    const c = new HerdrCliClient(exec);
    await c.reportMetadata("w1:p1", "mypi", { title: "x", tokens: {} });
    expect(calls[0]).not.toContain("--token");
  });

  it("reportMetadata skips a token whose value is undefined", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    const c = new HerdrCliClient(exec);
    await c.reportMetadata("w1:p1", "mypi", {
      title: "x",
      // The record type says string, but a caller can still hand over undefined.
      tokens: { state: undefined, cost: "0.41" } as unknown as Record<string, string>,
    });
    expect(calls[0]).toEqual([
      "pane",
      "report-metadata",
      "w1:p1",
      "--source",
      "mypi",
      "--title",
      "x",
      "--token",
      "cost=0.41",
    ]);
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
    expect(calls[0]).toEqual([
      "pane",
      "split",
      "w1:p1",
      "--direction",
      "down",
      "--ratio",
      "0.5",
      "--no-focus",
      "--env",
      "SHELL_SESSIONS_DISABLE=1",
    ]);
  });

  it("createPane defaults to --current when no paneId", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
    };
    const c = new HerdrCliClient(exec);
    await c.createPane({ direction: "right" });
    expect(calls[0]).toEqual([
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--no-focus",
      "--env",
      "SHELL_SESSIONS_DISABLE=1",
    ]);
  });

  it("createPane disables the macOS Terminal session restore in every pane", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
    };
    const c = new HerdrCliClient(exec);
    await c.createPane({ direction: "right", cwd: "/x" });
    expect(calls[0]).toContain("SHELL_SESSIONS_DISABLE=1");
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
