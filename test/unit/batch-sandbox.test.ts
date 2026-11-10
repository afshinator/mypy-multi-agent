import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentConfigDir,
  sandboxAvailable,
  sandboxedAgent,
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

  it("reports availability from the filesystem, not from the platform guess", () => {
    expect(sandboxAvailable()).toBe(existsSync("/usr/bin/sandbox-exec"));
  });

  it("can be forced off, so the path Linux takes is testable on a Mac (#492)", async () => {
    await withNoSandbox("1", () => expect(sandboxAvailable()).toBe(false));
    // Only "off" is honoured: a value that does not say so changes nothing.
    await withNoSandbox("0", () =>
      expect(sandboxAvailable()).toBe(existsSync("/usr/bin/sandbox-exec")),
    );
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
    expect(readdirSync(dir).sort()).toEqual(["auth.json", "models-store.json", "models.json"]);
  });

  it("copies what exists, so a source without a catalog still yields a usable dir", () => {
    writeFileSync(join(home, "auth.json"), '{"token":"x"}\n');

    const dir = agentConfigDir(home);
    dirs.push(dir);

    expect(readdirSync(dir)).toEqual(["auth.json"]);
  });

  it("gives pi a writable directory even when there is no auth file", () => {
    const dir = agentConfigDir(home);
    dirs.push(dir);

    // pi writes a trust lock on start, so the directory must exist and be writable.
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(join(dir, "probe.txt"), "x");
    expect(existsSync(join(dir, "probe.txt"))).toBe(true);
  });
});
