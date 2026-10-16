/**
 * Unit tests for the status adapter module.
 */
import { describe, expect, it } from "vitest";
import type { HerdrClient, PaneMetadata } from "../../src/herdr/herdr-client";
import { composeDisplayAgent, StatusAdapter } from "../../src/herdr/status-adapter";

/** Recorded `setStatus` calls plus a HerdrClient fake for the one method it uses. */
function makeClient(): { client: HerdrClient; calls: [string, string, PaneMetadata][] } {
  const calls: [string, string, PaneMetadata][] = [];
  const client: HerdrClient = {
    createPane: async () => "",
    runCommand: async () => {},
    reportMetadata: async (paneId, source, meta) => void calls.push([paneId, source, meta]),
    closePane: async () => {},
  };
  return { client, calls };
}

describe("StatusAdapter", () => {
  it("setStatus maps the canonical state to the pane title", async () => {
    const { client, calls } = makeClient();
    const a = new StatusAdapter(client, "mypi");
    await a.setStatus("p1", {
      id: "dev_a",
      state: "WORKING",
      cost: "0.41",
      tokens: "34210",
      role: "Developer A",
      model: "commandcode/z-ai/glm-5.3-flash",
    });
    expect(calls[0]![0]).toBe("p1");
    expect(calls[0]![1]).toBe("mypi");
    expect(calls[0]![2]).toMatchObject({
      title: "dev_a · WORKING · Developer A · commandcode/z-ai/glm-5.3-flash · 34210 tok · $0.41",
    });
  });

  it("shows displayState in the title while the token map keeps the canonical state", async () => {
    const { client, calls } = makeClient();
    const a = new StatusAdapter(client, "mypi");
    await a.setStatus("p1", {
      id: "dev_a",
      state: "WORKING",
      displayState: "STALLED",
      progress: "5m",
    });
    expect(calls[0]?.[2]?.title).toBe("dev_a · STALLED 5m");
    expect(calls[0]?.[2]?.tokens).toEqual({ state: "WORKING", progress: "5m" });
  });

  it("omits the state token for STOPPED but keeps it in the title (§14.4)", async () => {
    const { client, calls } = makeClient();
    const a = new StatusAdapter(client, "mypi");
    await a.setStatus("p1", { id: "dev_a", state: "STOPPED", role: "Developer A" });
    expect(calls[0]?.[2]?.title).toBe("dev_a · STOPPED · Developer A");
    expect(calls[0]?.[2]?.tokens).toEqual({ role: "Developer A" });
  });

  it.each(["STARTING", "PENDING", "WORKING", "WAITING", "DONE"])(
    "emits the state token for self-reportable %s",
    async (state) => {
      const { client, calls } = makeClient();
      const a = new StatusAdapter(client, "mypi");
      await a.setStatus("p1", { state });
      expect(calls[0]?.[2]?.tokens).toEqual({ state });
    },
  );

  it("setStatus forwards the structured tokens, not only the title", async () => {
    const { client, calls } = makeClient();
    const a = new StatusAdapter(client, "mypi");
    await a.setStatus("p1", {
      id: "dev_a",
      state: "WORKING",
      cost: "0.41",
      tokens: "34210",
      role: "Developer A",
      model: "commandcode/z-ai/glm-5.3-flash",
      progress: "12s",
    });
    expect(calls[0]?.[2]?.tokens).toEqual({
      state: "WORKING",
      role: "Developer A",
      model: "commandcode/z-ai/glm-5.3-flash",
      tokens: "34210",
      cost: "0.41",
      progress: "12s",
    });
  });
});

describe("composeDisplayAgent", () => {
  it("joins id, state, role, model, tokens, and cost with a separator", () => {
    expect(
      composeDisplayAgent({
        id: "dev_a",
        state: "WORKING",
        role: "Developer A",
        model: "commandcode/z-ai/glm-5.3-flash",
        tokens: "34210",
        cost: "0.41",
      }),
    ).toBe("dev_a · WORKING · Developer A · commandcode/z-ai/glm-5.3-flash · 34210 tok · $0.41");
  });

  it("omits unset fields", () => {
    expect(composeDisplayAgent({ state: "WORKING", role: "Developer A" })).toBe(
      "WORKING · Developer A",
    );
    expect(composeDisplayAgent({ state: "DONE" })).toBe("DONE");
    expect(composeDisplayAgent({ id: "x", state: "WORKING", model: "m", cost: "0.01" })).toBe(
      "x · WORKING · m · $0.01",
    );
  });

  it("appends the progress age to the state segment", () => {
    expect(
      composeDisplayAgent({
        id: "dev_a",
        state: "WORKING",
        progress: "12s",
        role: "Developer A",
        model: "commandcode/z-ai/glm-5.3-flash",
        tokens: "34210",
        cost: "0.41",
      }),
    ).toBe(
      "dev_a · WORKING 12s · Developer A · commandcode/z-ai/glm-5.3-flash · 34210 tok · $0.41",
    );
  });

  it("is unchanged when no progress is present", () => {
    expect(composeDisplayAgent({ state: "WORKING", role: "Developer A" })).toBe(
      "WORKING · Developer A",
    );
  });

  it("prefers displayState over the canonical state in the title segment", () => {
    expect(
      composeDisplayAgent({
        id: "dev_a",
        state: "WORKING",
        displayState: "STALLED",
        progress: "5m",
      }),
    ).toBe("dev_a · STALLED 5m");
  });
});
