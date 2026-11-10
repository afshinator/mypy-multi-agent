/**
 * The sandbox the batch's own agents run in (#487). Their bash tool executes commands a model wrote
 * from untrusted ticket text, so the process tree is confined to the clone and the temp directories:
 * it cannot write anywhere else and cannot read the credential stores a claim has no reason to open.
 *
 * Measured limits, deliberately not papered over:
 * - Egress cannot be scoped. The profile language rejects host and IP rules, and `pi` needs the
 *   provider, so a claim can still send out what the clone holds.
 * - `~/.pi` is not exposed at all: the child gets a throwaway config directory with only `auth.json`,
 *   because pi writes a trust lock on start. That copy is readable by the sandboxed bash.
 * - macOS only. Without `sandbox-exec` the spawn is unchanged, which is why a Linux run is uncovered.
 */
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Temp roots a model-written command may write to. `/tmp` is a symlink, so the real paths are used. */
const WRITABLE_TEMP = ["/private/tmp", "/private/var/folders"];

/** Devices every shell needs: `git` opens `/dev/null` read-write before it does anything. */
const SAFE_DEVICES = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"];

/** Credential stores under the operator's home that no claim needs to read. */
const SECRET_DIRS = [".ssh", ".aws", ".gnupg"];

/** Credential files, as opposed to directories. */
const SECRET_FILES = [".netrc"];

const quote = (path: string): string => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The SBPL profile for one agent run. Last matching rule wins, so the allowlist follows the blanket
 * deny and re-opens exactly the clone, the agent's config directory, the temp roots and the devices.
 */
export function sandboxProfile(input: { clone: string; configDir: string; home: string }): string {
  const writable = [input.clone, input.configDir, ...WRITABLE_TEMP].map(
    (path) => `(subpath ${quote(path)})`,
  );
  const devices = SAFE_DEVICES.map((path) => `(literal ${quote(path)})`);
  const noRead = [
    ...SECRET_DIRS.map((name) => `(subpath ${quote(join(input.home, name))})`),
    ...SECRET_FILES.map((name) => `(literal ${quote(join(input.home, name))})`),
  ];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${[...writable, ...devices].join(" ")})`,
    `(deny file-read-data ${noRead.join(" ")})`,
    "",
  ].join("\n");
}

/** `sandbox-exec` is macOS-only; everywhere else the spawn runs unchanged. */
export function sandboxAvailable(): boolean {
  return existsSync(SANDBOX_EXEC);
}

/** `pi` and its argv, behind the sandbox when there is one. */
export function sandboxedAgent(
  argv: readonly string[],
  profile: string,
  available = sandboxAvailable(),
): string[] {
  return available ? [SANDBOX_EXEC, "-p", profile, "pi", ...argv] : [...argv];
}

/**
 * A throwaway `PI_CODING_AGENT_DIR` holding only the operator's `auth.json`. pi writes a trust lock
 * on start, so the real config directory cannot be mounted read-only, and it must not be exposed at
 * all: a model-written command that could edit `settings.json` would run code in the next session.
 */
export function agentConfigDir(
  source = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"),
): string {
  const dir = mkdtempSync(join(tmpdir(), "mypi-agent-cfg-"));
  const auth = join(source, "auth.json");
  if (existsSync(auth)) copyFileSync(auth, join(dir, "auth.json"));
  return dir;
}
