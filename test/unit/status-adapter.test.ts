/**
 * Unit tests for the status adapter module.
 */
import { describe, expect, it } from "vitest";
import { StatusAdapter } from "../../src/herdr/status-adapter";
import type { HerdrClient, PaneMetadata } from "../../src/herdr/herdr-client";

describe("StatusAdapter", () => {
  it("setStatus maps the canonical state to reportMetadata", async () => {
    const calls: [string, string, PaneMetadata][] = [];
    const client: HerdrClient = {
      createPane: async () => "",
      runCommand: async () => {},
      reportMetadata: async (paneId, source, meta) => void calls.push([paneId, source, meta]),
      closePane: async () => {},
    };
    const a = new StatusAdapter(client, "mypi");
    await a.setStatus("p1", { state: "WORKING", cost: "0.41", tokens: "34210", title: "Task: X", role: "Developer A", model: "commandcode/z-ai/glm-5.3-flash" });
    expect(calls[0]![0]).toBe("p1");
    expect(calls[0]![1]).toBe("mypi");
    expect(calls[0]![2]).toMatchObject({ state: "WORKING", cost: "0.41", tokens: "34210", title: "Task: X", role: "Developer A", model: "commandcode/z-ai/glm-5.3-flash" });
  });
});
