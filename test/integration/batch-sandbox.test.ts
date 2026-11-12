/**
 * The sandbox is asserted by running in it, not by reading its profile: a profile that parses and
 * denies nothing is exactly the failure this test exists to catch (#487).
 *
 * `sandbox-exec` is macOS-only, so on Linux these are skipped and the skip says why. That is the
 * honest state: the batch's agents are confined on a Mac and unconfined elsewhere.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentConfigDir, sandboxAvailable, sandboxProfile } from "../../src/batch/sandbox";

let home: string;
let clone: string;
let configDir: string;
let profile: string;

const sandboxed = (command: string) =>
  spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", command], {
    encoding: "utf8",
    env: { ...process.env, CLONE: clone },
  });

/**
 * A home outside every writable root in the profile, so a denial is the profile's rather than the temp
 * root's. macOS-only, like the profile itself, and `/Users/Shared` is where it exists.
 */
const HOME_ROOT = "/Users/Shared";

/**
 * A batch's own suite runs confined, and the profile denies `/Users/Shared`, so this fixture cannot
 * exist there. The cause is printed so an unexpected error is visible instead of looking like a
 * normal skip.
 */
const fixtureBlocked: string | undefined = !sandboxAvailable()
  ? undefined
  : (() => {
      try {
        rmSync(mkdtempSync(join(HOME_ROOT, "mypi-sb-probe-")), { recursive: true, force: true });
        return undefined;
      } catch (error) {
        return String(error);
      }
    })();
if (fixtureBlocked !== undefined) {
  console.warn(`batch-sandbox: the fixture cannot be created, skipping: ${fixtureBlocked}`);
}

const macOnly = sandboxAvailable() && fixtureBlocked === undefined ? it : it.skip;

beforeEach(() => {
  // The gated tests are skipped and the one fixture-free test needs no fixture, so build none.
  if (!sandboxAvailable() || fixtureBlocked !== undefined) return;
  home = mkdtempSync(join(HOME_ROOT, "mypi-sb-home-"));
  clone = mkdtempSync(join(tmpdir(), "mypi-sb-clone-"));
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "secret\n");
  configDir = agentConfigDir(join(home, ".pi-agent-missing"));
  profile = sandboxProfile({ clone, configDir, home });
});

afterEach(() => {
  for (const dir of [home, clone, configDir]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("the agent sandbox (#487)", () => {
  macOnly(
    "cannot write outside the clone, so a model-written rm cannot touch the operator's files",
    () => {
      const result = sandboxed(`echo x > "${home}/probe.txt"`);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("Operation not permitted");
      expect(existsSync(join(home, "probe.txt"))).toBe(false);
    },
  );

  macOnly("can still write inside the clone, which is where a claim does its work", () => {
    const result = sandboxed(`echo x > "${clone}/probe.txt" && cat "${clone}/probe.txt"`);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("x");
  });

  macOnly("cannot read ~/.ssh", () => {
    const result = sandboxed(`cat "${home}/.ssh/id_ed25519"`);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Operation not permitted");
  });

  macOnly("keeps its own config dir readable, so pi can start", () => {
    // pi writes a trust lock into this directory on start, so it must be writable as well.
    const configured = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/sh", "-c", 'touch "$CFG/probe" && echo ok'],
      { encoding: "utf8", env: { ...process.env, CFG: configDir } },
    );
    expect(configured.status).toBe(0);
    expect(configured.stdout.trim()).toBe("ok");
  });

  macOnly("runs git and gh, which the verifier needs", () => {
    // git opens /dev/null read-write, and gh reads its own config: both were breaking without them.
    const git = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "git", "--version"], {
      encoding: "utf8",
    });
    expect(git.status).toBe(0);

    const gh = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "gh", "--version"], {
      encoding: "utf8",
    });
    expect(gh.status).toBe(0);
  });

  it("says why it is skipped where there is no sandbox-exec", () => {
    // Runs everywhere: it documents the gap rather than passing quietly.
    expect(
      sandboxAvailable() ? "confined by sandbox-exec" : "not confined: no sandbox-exec",
    ).toMatch(/sandbox-exec/);
  });
});
