import { describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";

const priced = () => false; // no model is free by default

function minimal(): any {
  return {
    version: "1.1",
    session: { id: "s1", max_cost_usd: 5, agent_stop_threshold_percent: 85 },
    ask: { title: "t", description: "d", definition_of_done: "dod" },
    agents: [
      {
        id: "a1",
        title: "Agent A",
        model: "provider/model",
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: 1,
        system_prompt: "sp",
      },
    ],
  };
}

function full() {
  return {
    version: "1.1",
    session: {
      id: "sec-audit-01",
      workspace_root: "./",
      max_cost_usd: 5.0,
      agent_stop_threshold_percent: 85,
    },
    ask: {
      title: "Security & Architecture Review",
      description: "Review JWT middleware in ./src/auth.ts.",
      definition_of_done: "Reconciled result covering trade-offs, vulns, recommendations.",
    },
    agents: [
      {
        id: "architect",
        title: "System Architect",
        model: "anthropic/claude-3-7-sonnet",
        capabilities: ["System design"],
        limits: ["Does not produce exploit payloads"],
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: 1.0,
        max_tokens: 250000,
        system_prompt: "You are the System Architect.",
      },
      {
        id: "code_fixer",
        title: "Code Fixer",
        model: "deepseek/deepseek-r1",
        capabilities: ["Implementation"],
        limits: [],
        permissions: { read: true, edit: true, shell: true },
        max_cost_usd: 0.5,
        system_prompt: "You are the Code Fixer.",
      },
    ],
    bus: {
      transport: "unix",
      socket_path: "<ask-directory>/.a2a-agent-bus.sock",
      heartbeat_interval_ms: 1000,
    },
  };
}

describe("session-schema", () => {
  it("1. minimal valid config", () => {
    expect(() => parseSessionConfig(minimal(), priced)).not.toThrow();
  });

  it("2. full valid config", () => {
    expect(() => parseSessionConfig(full(), priced)).not.toThrow();
  });

  it("3. missing required top-level field", () => {
    const c = minimal();
    delete (c as Record<string, unknown>).ask;
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("4. unknown top-level field", () => {
    const c = { ...minimal(), extra: true };
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("5. task: rejected", () => {
    const c = { ...minimal(), task: "alias" };
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("6. duplicate agent IDs", () => {
    const c = minimal();
    c.agents = [c.agents[0]!, { ...c.agents[0]! }];
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("7. invalid permission key", () => {
    const c = minimal();
    (c.agents[0]!.permissions as Record<string, unknown>).foo = true;
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("8. invalid stop threshold", () => {
    const c = minimal();
    c.session.agent_stop_threshold_percent = 120;
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("9. invalid budget", () => {
    const c = minimal();
    c.session.max_cost_usd = 0;
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("10. heartbeat timeout defaults to 3000", () => {
    const parsed = parseSessionConfig(minimal(), priced);
    expect(parsed.session.heartbeat_timeout_ms).toBe(3000);
  });

  it("11. heartbeat timeout below 2x interval rejected", () => {
    const c = minimal();
    (c.session as Record<string, unknown>).heartbeat_timeout_ms = 1500;
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("12. finalization grace time defaults to 30000", () => {
    const parsed = parseSessionConfig(minimal(), priced);
    expect(parsed.session.finalization_grace_ms).toBe(30000);
  });

  it("13. finalization grace cost defaults to 10%", () => {
    const parsed = parseSessionConfig(minimal(), priced);
    expect(parsed.session.finalization_grace_usd).toBeCloseTo(0.5);
  });

  it("14. allowlist with shell: false rejected", () => {
    const c = minimal();
    c.agents[0]!.shell_allowlist = ["git status"];
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("15. allowlist with shell: true accepted", () => {
    const c = minimal();
    c.agents[0]!.permissions.shell = true;
    c.agents[0]!.permissions.edit = false;
    c.agents[0]!.shell_allowlist = ["git status", "git diff"];
    expect(() => parseSessionConfig(c, priced)).not.toThrow();
  });

  it("16. max_tokens accepted for a priced agent", () => {
    const c = minimal();
    c.agents[0]!.max_tokens = 1000;
    expect(() => parseSessionConfig(c, priced)).not.toThrow();
  });

  it("17. free agent without max_tokens rejected", () => {
    const isFree = (model: string) => model === "provider/model";
    expect(() => parseSessionConfig(minimal(), isFree)).toThrow();
  });

  it("18. free agent with max_tokens accepted", () => {
    const c = minimal();
    c.agents[0]!.max_tokens = 1000;
    const isFree = (model: string) => model === "provider/model";
    expect(() => parseSessionConfig(c, isFree)).not.toThrow();
  });

  it("20. supervisor_system_prompt accepted", () => {
    const c = minimal();
    (c.session as Record<string, unknown>).supervisor_system_prompt = "be extra careful";
    expect(() => parseSessionConfig(c, priced)).not.toThrow();
  });

  it("19. negative or zero max_tokens rejected", () => {
    for (const v of [0, -5]) {
      const c = minimal();
      c.agents[0]!.max_tokens = v;
      expect(() => parseSessionConfig(c, priced)).toThrow();
    }
  });
});
