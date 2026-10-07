/**
 * Unit tests for the status adapter module.
 */
import { describe, expect, it } from "vitest";
import { StatusAdapter, composeDisplayAgent } from "../../src/herdr/status-adapter";
import type { HerdrClient, PaneMetadata } from "../../src/herdr/herdr-client";

describe("StatusAdapter", () => {
  it("setStatus maps the canonical state to the pane title", async () => {
    const calls: [string, string, PaneMetadata][] = [];
    const client: HerdrClient = {
      createPane: async () => "",
      runCommand: async () => {},
      reportMetadata: async (paneId, source, meta) => void calls.push([paneId, source, meta]),
      closePane: async () => {},
    };
    const a = new StatusAdapter(client, "mypi");
    await a.setStatus("p1", { id: "dev_a", state: "WORKING", cost: "0.41", tokens: "34210", role: "Developer A", model: "commandcode/z-ai/glm-5.3-flash" });
    expect(calls[0]![0]).toBe("p1");
    expect(calls[0]![1]).toBe("mypi");
    expect(calls[0]![2]).toMatchObject({
      title: "dev_a · WORKING · Developer A · commandcode/z-ai/glm-5.3-flash · 34210 tok · $0.41",
    });
  });
});

describe("composeDisplayAgent", () => {
  it("joins id, state, role, model, tokens, and cost with a separator", () => {
    expect(composeDisplayAgent({ id: "dev_a", state: "WORKING", role: "Developer A", model: "commandcode/z-ai/glm-5.3-flash", tokens: "34210", cost: "0.41" }))
      .toBe("dev_a · WORKING · Developer A · commandcode/z-ai/glm-5.3-flash · 34210 tok · $0.41");
  });

  it("omits unset fields", () => {
    expect(composeDisplayAgent({ state: "WORKING", role: "Developer A" })).toBe("WORKING · Developer A");
    expect(composeDisplayAgent({ state: "DONE" })).toBe("DONE");
    expect(composeDisplayAgent({ id: "x", state: "WORKING", model: "m", cost: "0.01" })).toBe("x · WORKING · m · $0.01");
  });
});
