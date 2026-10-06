import { describe, expect, it } from "vitest";
import { toPeerConfig, toolsForPermissions, type PeerConfig } from "../../src/peer/peer-config";
import type { SessionConfig } from "../../src/contracts/session-schema";

const agent = (over: Record<string, unknown> = {}) =>
  ({
    id: "a1",
    title: "A",
    model: "m/m",
    permissions: { read: true, edit: false, shell: false },
    max_cost_usd: 1,
    system_prompt: "sp",
    ...over,
  }) as SessionConfig["agents"][number];

describe("toPeerConfig", () => {
  it("maps the agent fields and bus path", () => {
    const c = toPeerConfig(agent({ shell_allowlist: ["git status"], max_tokens: 400000 }), "/tmp/bus.sock");
    expect(c).toMatchObject({
      agentId: "a1",
      model: "m/m",
      systemPrompt: "sp",
      permissions: { read: true, edit: false, shell: false },
      maxCostUsd: 1,
      maxTokens: 400000,
      shellAllowlist: ["git status"],
      busPath: "/tmp/bus.sock",
    } satisfies Partial<PeerConfig>);
  });
});

describe("toolsForPermissions", () => {
  it("read-only: read + search tools, no edit/write/bash", () => {
    expect(toolsForPermissions({ read: true, edit: false, shell: false })).toEqual(["read", "grep", "ls", "find"]);
  });

  it("edit: adds edit + write", () => {
    expect(toolsForPermissions({ read: true, edit: true, shell: false })).toEqual(["read", "grep", "ls", "find", "edit", "write"]);
  });

  it("shell + edit: adds bash", () => {
    expect(toolsForPermissions({ read: true, edit: true, shell: true })).toEqual(["read", "grep", "ls", "find", "edit", "write", "bash"]);
  });

  it("shell on but edit off: bash included (allowlist enforced by the tool_call gate)", () => {
    expect(toolsForPermissions({ read: true, edit: false, shell: true })).toEqual(["read", "grep", "ls", "find", "bash"]);
  });

  it("read false: no tools", () => {
    expect(toolsForPermissions({ read: false, edit: false, shell: false })).toEqual([]);
  });
});
