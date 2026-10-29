/**
 * Unit tests for the peer config module.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSocketPath } from "../../src/bus/socket-server";
import type { SessionConfig } from "../../src/contracts/session-schema";
import {
  type PeerConfig,
  peerToolLogPath,
  stallTimeoutForAgent,
  toolsForPermissions,
  toPeerConfig,
} from "../../src/peer/peer-config";

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
    const policy = { pauseMs: 30000, maxRetries: 3, stallTimeoutMs: 300000 };
    const c = toPeerConfig(
      agent({ shell_allowlist: ["git status"], max_tokens: 400000 }),
      "/tmp/bus.sock",
      "/repo",
      policy,
      "/repo/.mypi/t/run-details",
    );
    expect(c).toMatchObject({
      agentId: "a1",
      model: "m/m",
      systemPrompt: "sp",
      permissions: { read: true, edit: false, shell: false },
      maxCostUsd: 1,
      maxTokens: 400000,
      shellAllowlist: ["git status"],
      busPath: "/tmp/bus.sock",
      runDetailsDir: "/repo/.mypi/t/run-details",
      workspaceRoot: "/repo",
      title: "A",
      retryPauseMs: 30000,
      retryMaxRetries: 3,
      stallTimeoutMs: 300000,
    } satisfies Partial<PeerConfig>);
  });
});

describe("stallTimeoutForAgent (issue #134)", () => {
  const session = { stall_timeout_ms: 300000, free_class_stall_timeout_ms: 120000 };
  const free = (m: string) => m.startsWith("free/");

  it("a free-class slug gets the free-class deadline; a priced slug keeps the session value", () => {
    expect(stallTimeoutForAgent({ model: "free/x" }, session, free)).toBe(120000);
    expect(stallTimeoutForAgent({ model: "paid/y" }, session, free)).toBe(300000);
  });

  it("free_class_stall_timeout_ms: 0 disables the class override", () => {
    expect(
      stallTimeoutForAgent(
        { model: "free/x" },
        { stall_timeout_ms: 300000, free_class_stall_timeout_ms: 0 },
        free,
      ),
    ).toBe(300000);
  });

  it("is the deadline the peer is given, for a peer of each class (toPeerConfig policy seam)", () => {
    for (const [model, expected] of [
      ["free/x", 120000],
      ["paid/y", 300000],
    ] as const) {
      const a = agent({ model });
      const c = toPeerConfig(
        a,
        "/tmp/bus.sock",
        "/repo",
        { pauseMs: 30, maxRetries: 3, stallTimeoutMs: stallTimeoutForAgent(a, session, free) },
        "/repo/.mypi/t/run-details",
      );
      expect(c.stallTimeoutMs).toBe(expected);
    }
  });
});

describe("peerToolLogPath", () => {
  it("logs under run-details, not beside the socket", () => {
    expect(peerToolLogPath({ runDetailsDir: "/repo/.mypi/t/run-details" })).toBe(
      join("/repo/.mypi/t/run-details", "tool-calls.jsonl"),
    );
  });

  it("stays in run-details when the run path is long enough to move the socket to tmpdir (issue #23)", () => {
    const askDir = join(`/${"a".repeat(100)}`, "run-details");
    // Precondition: the socket really did leave the run directory.
    expect(resolveSocketPath(askDir).startsWith(tmpdir())).toBe(true);
    expect(peerToolLogPath({ runDetailsDir: askDir })).toBe(join(askDir, "tool-calls.jsonl"));
  });
});

describe("toolsForPermissions", () => {
  it("read-only: read + search + web tools, no edit/write/bash", () => {
    expect(toolsForPermissions({ read: true, edit: false, shell: false })).toEqual([
      "read",
      "grep",
      "ls",
      "find",
      "web_fetch",
    ]);
  });

  it("edit: adds edit + write", () => {
    expect(toolsForPermissions({ read: true, edit: true, shell: false })).toEqual([
      "read",
      "grep",
      "ls",
      "find",
      "web_fetch",
      "edit",
      "write",
    ]);
  });

  it("shell + edit: adds bash", () => {
    expect(toolsForPermissions({ read: true, edit: true, shell: true })).toEqual([
      "read",
      "grep",
      "ls",
      "find",
      "web_fetch",
      "edit",
      "write",
      "bash",
    ]);
  });

  it("shell on but edit off: bash included (allowlist enforced by the tool_call gate)", () => {
    expect(toolsForPermissions({ read: true, edit: false, shell: true })).toEqual([
      "read",
      "grep",
      "ls",
      "find",
      "web_fetch",
      "bash",
    ]);
  });

  it("read false: no tools", () => {
    expect(toolsForPermissions({ read: false, edit: false, shell: false })).toEqual([]);
  });
});
