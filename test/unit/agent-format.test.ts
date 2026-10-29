/**
 * Unit tests for the list_agents formatter (cost/token visibility).
 */
import { describe, expect, it } from "vitest";
import { UsageAccounting } from "../../src/budget/usage-accounting";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import { briefing, describeWaitFailure, formatAgents, replyText } from "../../src/pi/extension";

describe("formatAgents", () => {
  it("renders id, state, cost, and tokens per agent", () => {
    const accounting = new UsageAccounting();
    accounting.recordUsage({ agentId: "dev_a", cost: 0.42, tokens: 1234 });
    accounting.recordUsage({ agentId: "dev_b", cost: 0, tokens: 50 });
    const out = formatAgents(
      ["dev_a", "dev_b"],
      new Map([
        ["dev_a", "DONE"],
        ["dev_b", "WORKING"],
      ]),
      accounting,
    );
    expect(out).toContain("- dev_a (DONE) — $0.4200 / 1234 tokens");
    expect(out).toContain("- dev_b (WORKING) — $0.0000 / 50 tokens");
  });
});

describe("replyText", () => {
  const env = (type: string, payload: unknown): A2AEnvelope =>
    ({
      id: "e",
      timestamp: 0,
      sender: "peer1",
      recipient: "supervisor",
      type,
      payload,
    }) as A2AEnvelope;

  it("renders an AGENT_UNUSABLE reply with reason and attempts", () => {
    const out = replyText(
      env("AGENT_UNUSABLE", { agentId: "peer1", reason: "empty model output", attempts: 4 }),
    );
    expect(out).toContain("peer1");
    expect(out).toContain("UNUSABLE");
    expect(out).toContain("empty model output");
    expect(out).toContain("4");
  });

  it("renders the provider's own message on an AGENT_UNUSABLE reply", () => {
    const out = replyText(
      env("AGENT_UNUSABLE", {
        agentId: "peer1",
        reason: "empty model output",
        attempts: 4,
        error: '412: {"message":"Account suspended"}',
      }),
    );
    expect(out).toContain("412");
    expect(out).toContain("Account suspended");
  });

  it("renders an AGENT_CRASHED reply", () => {
    expect(replyText(env("AGENT_CRASHED", { agentId: "peer1", reason: "disconnected" }))).toContain(
      "CRASHED",
    );
  });

  it("renders an AGENT_STALLED reply with the idle time", () => {
    const out = replyText(
      env("AGENT_STALLED", { agentId: "peer1", reason: "no turn progress", elapsedMs: 300000 }),
    );
    expect(out).toContain("peer1");
    expect(out).toContain("STALLED");
    expect(out).toContain("300000");
  });

  it("renders a normal text payload", () => {
    expect(replyText(env("RESPONSE", { agentId: "peer1", text: "hello" }))).toBe("hello");
  });
});

describe("describeWaitFailure", () => {
  it("labels a crashed peer as terminal", () => {
    expect(describeWaitFailure("CRASHED", "peer1", 120000, "timed out")).toContain("CRASHED");
  });

  it("tells the supervisor a live peer is still working, with the timeout and a re-ask hint", () => {
    const out = describeWaitFailure("WORKING", "peer1", 120000, "timed out");
    expect(out).toContain("still working");
    expect(out).toContain("120000");
    expect(out).toContain("reassign");
  });

  it("falls back when the state is unknown", () => {
    expect(describeWaitFailure(undefined, "peer1", 1000, "boom")).toContain("wait on peer1 failed");
  });
});

describe("briefing", () => {
  const config = parseSessionConfig({
    version: "1.1",
    session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "a" },
    ask: { title: "t", description: "d", definition_of_done: ["done"] },
    agents: [
      {
        id: "a",
        title: "A",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: 1,
        system_prompt: "sp",
      },
    ],
  });

  it("lists detected analyzers when present (P1-2)", () => {
    const out = briefing(config, "/ask", ["fallow"]);
    expect(out).toContain("ANALYZERS");
    expect(out).toContain("fallow");
  });

  it("omits the analyzer section when none are detected", () => {
    expect(briefing(config, "/ask", [])).not.toContain("ANALYZERS");
  });

  it("names a read-only shell peer's runnable commands (RT-8 D1)", () => {
    const c = parseSessionConfig({
      version: "1.1",
      session: {
        id: "s",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        shell_vocabulary: ["git status", "go test ./..."],
        attester: "v",
      },
      ask: { title: "t", description: "d", definition_of_done: ["done"] },
      agents: [
        {
          id: "v",
          title: "V",
          model: "m/m",
          permissions: { read: true, edit: false, shell: true },
          max_cost_usd: 1,
          system_prompt: "sp",
        },
      ],
    });
    const out = briefing(c, "/ask", []);
    expect(out).toContain("can run only");
    expect(out).toContain('"go test ./..."');
  });
});
