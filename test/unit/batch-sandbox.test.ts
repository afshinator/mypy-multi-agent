import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentConfigDir,
  sandboxAvailable,
  sandboxedAgent,
  sandboxedPaneCommand,
  sandboxProfile,
} from "../../src/batch/sandbox";
import { withNoSandbox } from "../helpers/sandbox";

const PROFILE = sandboxProfile({
  clone: "/tmp/clone-1",
  configDir: "/private/tmp/cfg-1",
  home: "/Users/someone",
});

describe("sandbox profile (#487)", () => {
  it("denies every write before allowing the clone, the config dir, temp and the devices", () => {
    const lines = PROFILE.split("\n");
    const deny = lines.indexOf("(deny file-write*)");
    const allow = lines.findIndex((line) => line.startsWith("(allow file-write*"));

    expect(deny).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(deny); // last match wins, so the allowlist has to follow
    expect(lines[allow]).toContain('(subpath "/tmp/clone-1")');
    expect(lines[allow]).toContain('(subpath "/private/tmp/cfg-1")');
    // `/tmp` is a symlink on macOS, so the real temp roots are what a write matches.
    expect(lines[allow]).toContain('(subpath "/private/tmp")');
    expect(lines[allow]).toContain('(subpath "/private/var/folders")');
    // git opens /dev/null read-write before it does anything.
    expect(lines[allow]).toContain('(literal "/dev/null")');
  });

  it("denies reads of the credential stores and of ~/.netrc", () => {
    const deny = PROFILE.split("\n").find((line) => line.startsWith("(deny file-read-data")) ?? "";

    expect(deny).toContain('(subpath "/Users/someone/.ssh")');
    expect(deny).toContain('(subpath "/Users/someone/.aws")');
    expect(deny).toContain('(subpath "/Users/someone/.gnupg")');
    expect(deny).toContain('(literal "/Users/someone/.netrc")');
  });

  it("survives a clone path with a space in it", () => {
    const spaced = sandboxProfile({
      clone: "/tmp/a clone",
      configDir: "/private/tmp/cfg",
      home: "/Users/someone",
    });

    expect(spaced).toContain('(subpath "/tmp/a clone")');
  });

  it("prefixes pi with sandbox-exec when there is one, and leaves it alone when there is not", () => {
    expect(sandboxedAgent(["-p", "hi"], PROFILE, true)).toEqual([
      "/usr/bin/sandbox-exec",
      "-p",
      PROFILE,
      "pi",
      "-p",
      "hi",
    ]);
    expect(sandboxedAgent(["-p", "hi"], PROFILE, false)).toEqual(["-p", "hi"]);
  });

  it("reports availability from the filesystem or the override, not the platform guess", () => {
    // The unsandboxed check run sets MYPY_NO_SANDBOX=1, which forces the answer; otherwise the
    // filesystem decides — never process.platform. Both runs assert the same code path.
    const forced = process.env.MYPY_NO_SANDBOX === "1" || process.env.MYPY_NO_SANDBOX === "true";
    expect(sandboxAvailable()).toBe(forced ? false : existsSync("/usr/bin/sandbox-exec"));
  });

  it("can be forced off, so the path Linux takes is testable on a Mac (#492)", async () => {
    await withNoSandbox("1", () => expect(sandboxAvailable()).toBe(false));
    // Only "off" is honoured: a value that does not say so changes nothing.
    await withNoSandbox("0", () =>
      expect(sandboxAvailable()).toBe(existsSync("/usr/bin/sandbox-exec")),
    );
  });
});

describe("agentConfigDir — a sandboxed agent never waits for a keystroke (#552)", () => {
  it("states the project trust it grants its own clone", () => {
    // Measured: without it the pane stopped at "Trust project folder?" and the run never created
    // run-details/. The key is only read from agent-directory settings.
    const dir = agentConfigDir();
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      defaultProjectTrust?: string;
    };

    expect(settings.defaultProjectTrust).toBe("always");
  });
});

describe("sandboxedPaneCommand — the inner command's assignments (#549)", () => {
  it("runs it through env, so a leading VAR=value is an assignment rather than a program", () => {
    // Measured failure: `sandbox-exec: execvp() of 'MYPY_UNATTENDED=1' failed`, because argv after
    // the profile is exec'd literally and nothing parses an assignment there.
    const command = sandboxedPaneCommand(
      'MYPY_UNATTENDED=1 pi "/mypi-multi-agent b1"',
      "(p)",
      "/tmp/cfg",
      true,
    );

    expect(command).toContain('env MYPY_UNATTENDED=1 pi "/mypi-multi-agent b1"');
    expect(command).not.toMatch(/-p '\(p\)' MYPY_UNATTENDED=1/);
  });
});

describe("agentConfigDir (#487)", () => {
  let home: string;
  let dirs: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mypi-home-"));
    dirs = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("holds the auth file and the model catalog, and nothing else of pi's", () => {
    writeFileSync(join(home, "auth.json"), '{"token":"x"}\n');
    writeFileSync(join(home, "models.json"), '{"providers":{}}\n');
    writeFileSync(join(home, "models-store.json"), "{}\n");
    writeFileSync(join(home, "settings.json"), '{"theme":"dark"}\n');
    mkdirSync(join(home, "extensions"), { recursive: true });

    const dir = agentConfigDir(home);
    dirs.push(dir);

    // The catalog decides which slugs resolve: auth alone leaves a configured model "not found".
    // `settings.json` is the one file this directory writes for itself, and the operator's copy is
    // not it: their `theme` and their registered extensions stay out (#552).
    expect(readdirSync(dir).sort()).toEqual([
      "auth.json",
      "models-store.json",
      "models.json",
      "settings.json",
    ]);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).not.toContain("theme");
  });

  it("copies what exists, so a source without a catalog still yields a usable dir", () => {
    writeFileSync(join(home, "auth.json"), '{"token":"x"}\n');

    const dir = agentConfigDir(home);
    dirs.push(dir);

    expect(readdirSync(dir).sort()).toEqual(["auth.json", "settings.json"]);
  });

  it("gives pi a writable directory even when there is no auth file", () => {
    const dir = agentConfigDir(home);
    dirs.push(dir);

    // pi writes a trust lock on start, so the directory must exist and be writable.
    // Only the trust this sandbox states for itself, never a dependency on the operator's config.
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    writeFileSync(join(dir, "probe.txt"), "x");
    expect(existsSync(join(dir, "probe.txt"))).toBe(true);
  });
});
