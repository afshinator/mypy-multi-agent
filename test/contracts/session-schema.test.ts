/**
 * Schema contract tests for the session schema contract.
 */
import { describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";

const priced = () => false; // no model is free by default

// Structurally loose on purpose: these tests hand parseSessionConfig shapes
// that are deliberately invalid, so nested fields stay Record<string, unknown>.
function minimal(): {
  version: string;
  session: Record<string, unknown>;
  ask: Record<string, unknown>;
  agents: Record<string, unknown>[];
} {
  return {
    version: "1.1",
    session: { id: "s1", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "a1" },
    ask: { title: "t", description: "d", definition_of_done: ["dod"] },
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
      attester: "architect",
    },
    ask: {
      title: "Security & Architecture Review",
      description: "Review JWT middleware in ./src/auth.ts.",
      definition_of_done: ["Reconciled result covering trade-offs, vulns, recommendations."],
    },
    agents: [
      {
        id: "architect",
        title: "System Architect",
        model: "anthropic/claude-3-7-sonnet",
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: 1.0,
        max_tokens: 250000,
        system_prompt: "You are the System Architect.",
      },
      {
        id: "code_fixer",
        title: "Code Fixer",
        model: "deepseek/deepseek-r1",
        permissions: { read: true, edit: true, shell: true },
        max_cost_usd: 0.5,
        system_prompt: "You are the Code Fixer.",
      },
    ],
    bus: {
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
    expect(parsed.session.finalization_grace_ms).toBe(900000);
  });

  it("rejects the fields removed as dead config (issue #37)", () => {
    // They were parsed and documented as reserved but never read. The schema is
    // strict, so a config that sets one now fails loudly instead of silently
    // doing nothing.
    const cases: [string, (c: Record<string, any>) => void][] = [
      ["capabilities", (c) => (c.agents[0].capabilities = ["x"])],
      ["limits", (c) => (c.agents[0].limits = ["x"])],
      [
        "bus.transport",
        (c) => {
          c.bus = { ...(c.bus ?? {}), transport: "unix" };
        },
      ],
      [
        "bus.socket_path",
        (c) => {
          c.bus = { ...(c.bus ?? {}), socket_path: "/tmp/x.sock" };
        },
      ],
      ["finalization_grace_usd", (c) => (c.session.finalization_grace_usd = 1)],
    ];
    for (const [field, mutate] of cases) {
      const c = minimal() as unknown as Record<string, any>;
      mutate(c);
      expect(() => parseSessionConfig(c, priced), field).toThrow();
    }
  });

  it("peer retry pause defaults to 30000", () => {
    const parsed = parseSessionConfig(minimal(), priced);
    expect(parsed.session.peer_retry_pause_ms).toBe(30000);
  });

  it("peer max retries defaults to 3", () => {
    const parsed = parseSessionConfig(minimal(), priced);
    expect(parsed.session.peer_max_retries).toBe(3);
  });

  it("custom peer retry settings are accepted", () => {
    const c = minimal();
    c.session.peer_retry_pause_ms = 5000;
    c.session.peer_max_retries = 1;
    const parsed = parseSessionConfig(c, priced);
    expect(parsed.session.peer_retry_pause_ms).toBe(5000);
    expect(parsed.session.peer_max_retries).toBe(1);
  });

  it("peer prompt timeout defaults to 120000", () => {
    const parsed = parseSessionConfig(minimal(), priced);
    expect(parsed.session.peer_prompt_timeout_ms).toBe(120000);
  });

  it("wall_clock_ms is optional and accepted", () => {
    const c = minimal();
    c.session.wall_clock_ms = 1800000;
    expect(parseSessionConfig(c, priced).session.wall_clock_ms).toBe(1800000);
    const noWall = minimal();
    expect(parseSessionConfig(noWall, priced).session.wall_clock_ms).toBeUndefined();
  });

  it("wall_clock_ms rejects non-positive values", () => {
    const c = minimal();
    c.session.wall_clock_ms = 0;
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("verify_models defaults to warn", () => {
    expect(parseSessionConfig(minimal(), priced).session.verify_models).toBe("warn");
  });

  it("verify_models accepts strict/off and rejects anything else", () => {
    for (const mode of ["strict", "warn", "off"] as const) {
      const c = minimal();
      c.session.verify_models = mode;
      expect(parseSessionConfig(c, priced).session.verify_models).toBe(mode);
    }
    const bad = minimal();
    bad.session.verify_models = "maybe";
    expect(() => parseSessionConfig(bad, priced)).toThrow();
  });

  it("stop_at_work_order_boundary defaults to false and accepts true", () => {
    expect(parseSessionConfig(minimal(), priced).session.stop_at_work_order_boundary).toBe(false);
    const c = minimal();
    c.session.stop_at_work_order_boundary = true;
    expect(parseSessionConfig(c, priced).session.stop_at_work_order_boundary).toBe(true);
  });

  it("record_scorecard defaults to true and accepts false", () => {
    expect(parseSessionConfig(minimal(), priced).session.record_scorecard).toBe(true);
    const c = minimal();
    c.session.record_scorecard = false;
    expect(parseSessionConfig(c, priced).session.record_scorecard).toBe(false);
  });

  it("record_scorecard rejects a non-boolean", () => {
    const c = minimal();
    c.session.record_scorecard = "yes";
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("stall_timeout_ms defaults to 300000, accepts 0 to disable, rejects negative", () => {
    expect(parseSessionConfig(minimal(), priced).session.stall_timeout_ms).toBe(300000);
    const off = minimal();
    off.session.stall_timeout_ms = 0;
    expect(parseSessionConfig(off, priced).session.stall_timeout_ms).toBe(0);
    const bad = minimal();
    bad.session.stall_timeout_ms = -1;
    expect(() => parseSessionConfig(bad, priced)).toThrow();
  });

  it("free_class_stall_timeout_ms: default 120000, override accepted, malformed rejected (issue #134)", () => {
    expect(parseSessionConfig(minimal(), priced).session.free_class_stall_timeout_ms).toBe(120000);
    const c = minimal();
    c.session.free_class_stall_timeout_ms = 45000;
    expect(parseSessionConfig(c, priced).session.free_class_stall_timeout_ms).toBe(45000);
    // 0 disables the class override, mirroring stall_timeout_ms: 0.
    const off = minimal();
    off.session.free_class_stall_timeout_ms = 0;
    expect(parseSessionConfig(off, priced).session.free_class_stall_timeout_ms).toBe(0);
    for (const bad of [-1, 1.5, "120000"]) {
      const m = minimal();
      (m.session as Record<string, unknown>).free_class_stall_timeout_ms = bad;
      expect(() => parseSessionConfig(m, priced), `value ${bad}`).toThrow();
    }
  });

  it("14. allowlist with shell: false rejected", () => {
    const c = minimal();
    c.agents[0]!.shell_allowlist = ["git status"];
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("15. allowlist with shell: true accepted", () => {
    const c = minimal();
    const agent0 = c.agents[0]! as { permissions: { shell: boolean; edit: boolean } };
    agent0.permissions.shell = true;
    agent0.permissions.edit = false;
    c.agents[0]!.shell_allowlist = ["git status", "git diff"];
    expect(() => parseSessionConfig(c, priced)).not.toThrow();
  });

  it("15b. shell: true + edit: false without a non-empty allowlist rejected (RT-8 D1)", () => {
    const c = minimal();
    const agent0 = c.agents[0]! as { permissions: { shell: boolean } };
    agent0.permissions.shell = true;
    expect(() => parseSessionConfig(c, priced)).toThrow();
    c.agents[0]!.shell_allowlist = [];
    expect(() => parseSessionConfig(c, priced)).toThrow();
  });

  it("15c. session.shell_vocabulary satisfies and is inherited by a read-only shell peer (RT-8 D1)", () => {
    const c = minimal();
    const agent0 = c.agents[0]! as { permissions: { shell: boolean } };
    agent0.permissions.shell = true;
    c.session.shell_vocabulary = ["git status", "go test ./..."];
    const parsed = parseSessionConfig(c, priced);
    expect(parsed.agents[0]!.shell_allowlist).toEqual(["git status", "go test ./..."]);
  });

  it("15d. a per-agent shell_allowlist overrides the session vocabulary", () => {
    const c = minimal();
    const agent0 = c.agents[0]! as { permissions: { shell: boolean } };
    agent0.permissions.shell = true;
    c.session.shell_vocabulary = ["git status"];
    c.agents[0]!.shell_allowlist = ["go test ./..."];
    expect(parseSessionConfig(c, priced).agents[0]!.shell_allowlist).toEqual(["go test ./..."]);
  });

  it("15e. session.attester must name a configured agent", () => {
    const ok = minimal();
    (ok.session as Record<string, unknown>).attester = "a1";
    expect(() => parseSessionConfig(ok, priced)).not.toThrow();
    const bad = minimal();
    (bad.session as Record<string, unknown>).attester = "ghost";
    expect(() => parseSessionConfig(bad, priced)).toThrow(/not a configured agent/);
  });

  it("attester is required regardless of version (1.1 missing attester)", () => {
    const c = minimal();
    delete (c.session as Record<string, unknown>).attester;
    expect(() => parseSessionConfig(c, priced)).toThrow(/attester/);
    expect(() => parseSessionConfig(c, priced)).toThrow(/attester: <agent-id>/);
  });

  it("version 1.1 attester naming an unknown agent is rejected with the fix", () => {
    const c = minimal();
    (c.session as Record<string, unknown>).attester = "ghost";
    expect(() => parseSessionConfig(c, priced)).toThrow(/not a configured agent/);
    expect(() => parseSessionConfig(c, priced)).toThrow(/attester: <agent-id>/);
  });

  it("version 1.1 attester naming a configured agent parses", () => {
    const c = minimal();
    (c.session as Record<string, unknown>).attester = "a1";
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

  it("18b. unpriced agent with allow_unbounded:true accepted (RT-1)", () => {
    const c = minimal();
    c.agents[0]!.allow_unbounded = true;
    const isFree = (model: string) => model === "provider/model";
    expect(() => parseSessionConfig(c, isFree)).not.toThrow();
  });

  it("18c. unpriced agent without max_tokens or allow_unbounded rejected (RT-1)", () => {
    const isFree = () => true;
    expect(() => parseSessionConfig(minimal(), isFree)).toThrow(/requires max_tokens/);
  });

  it("22. supervisor_model accepted", () => {
    const c = minimal();
    (c.session as Record<string, unknown>).supervisor_model = "anthropic/claude-3-7-sonnet";
    expect(() => parseSessionConfig(c, priced)).not.toThrow();
  });

  it("21. validation commands accepted", () => {
    const c = { ...minimal(), validation: { commands: ["just test"] } };
    expect(() => parseSessionConfig(c, priced)).not.toThrow();
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

  it("22. definition_of_done accepts a non-empty list of criteria", () => {
    const c = minimal();
    c.ask.definition_of_done = ["a", "b"];
    expect(parseSessionConfig(c, priced).ask.definition_of_done).toEqual(["a", "b"]);
  });

  it("23. definition_of_done rejects an empty list or an empty criterion", () => {
    const empty = minimal();
    empty.ask.definition_of_done = [];
    expect(() => parseSessionConfig(empty, priced)).toThrow();
    const blank = minimal();
    blank.ask.definition_of_done = [""];
    expect(() => parseSessionConfig(blank, priced)).toThrow();
  });
});
