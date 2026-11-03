/**
 * The peer's extension list is policy, so it is decided by one exported function
 * and exercised here with fakes instead of by spawning a bus-connected pi.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileLock } from "../../src/peer/file-lock";
import { peerExtensions } from "../../src/peer/peer-extensions";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const deps = {
  permissions: { read: true, edit: true, shell: false },
  writeScope: (): string[] | undefined => [],
  resolvePath: (path: string): string => path,
  agentId: "a1",
  log: { append: () => {} } as never,
  trace: { startTurn: () => null } as never,
  send: (): void => {},
  locks: new FileLock(
    "a1",
    () => {},
    5000,
    (path: string) => path,
  ),
};

describe("peerExtensions", () => {
  it("returns all six factories in the order the peer must load them", () => {
    expect(peerExtensions(deps).map((entry) => entry.name)).toEqual([
      "permission-gate",
      "tool-call-logger",
      "change-notifier",
      "file-lock",
      "web-tool",
      "tool-result-hint",
    ]);
  });

  it("returns factories, not extensions", () => {
    for (const entry of peerExtensions(deps)) expect(typeof entry.factory).toBe("function");
  });

  it("keeps the peer policy in one place: no script hand-writes it", () => {
    // scripts/ is not typechecked, which is how the lock bound went missing and
    // made the peer's lock wait NaN.
    const script = readFileSync(join(repoRoot, "scripts/lock-proof.ts"), "utf8");
    expect(script).toContain("peerPolicy(");
    expect(script).not.toContain("lockAcquireTimeoutMs:");
    expect(script).not.toContain("stallTimeoutMs:");
  });

  it("keeps the list in one place: peer-main contains no factory", () => {
    const source = readFileSync(join(repoRoot, "src/peer/peer-main.ts"), "utf8");
    for (const name of [
      "permissionGate(",
      "toolCallLogger(",
      "changeNotifier(",
      "fileLock(",
      "webTool(",
      "toolResultHint(",
    ]) {
      expect(source).not.toContain(name);
    }
    expect(source).toContain("peerExtensions(");
  });
});
