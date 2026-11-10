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
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
export function sandboxProfile(input: {
  clone: string;
  configDir: string;
  home: string;
  /**
   * The git directory a worktree writes to. A worktree's `.git` is a *file* pointing at
   * `<repo>/.git/worktrees/<slug>`, so a commit creates its lock and objects there, not in the
   * worktree: measured, `git commit` fails with `Unable to create .../index.lock: Operation not
   * permitted` without it (#489).
   */
  gitDir?: string;
}): string {
  const writable = [
    input.clone,
    input.configDir,
    ...(input.gitDir === undefined ? [] : [input.gitDir]),
    ...WRITABLE_TEMP,
  ].map((path) => `(subpath ${quote(path)})`);
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

/**
 * `sandbox-exec` is macOS-only; everywhere else the spawn runs unchanged. `MYPY_NO_SANDBOX=1` forces
 * the unsandboxed answer so that path runs on a machine that has the sandbox: it is the only path
 * Linux ever takes, and it had no local test until #492. The variable can only turn the sandbox
 * off, so it can weaken a run but never fake protection that is not there.
 */
export function sandboxAvailable(): boolean {
  const forced = process.env.MYPY_NO_SANDBOX;
  if (forced === "1" || forced === "true") return false;
  return existsSync(SANDBOX_EXEC);
}

/** Quote a string for a POSIX shell command line. */
const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * A pane's command string, behind the sandbox when there is one. Panes are created by the herdr
 * daemon, so nothing is inherited: the config directory travels as an inline assignment, exactly as
 * `MYPY_UNATTENDED` already does (#415, #489).
 */
export function sandboxedPaneCommand(
  command: string,
  profile: string,
  configDir: string,
  available = sandboxAvailable(),
): string {
  if (!available) return command;
  return `PI_CODING_AGENT_DIR=${shellQuote(configDir)} ${SANDBOX_EXEC} -p ${shellQuote(profile)} ${command}`;
}

/**
 * Where a worktree's git writes land: its `.git` is a file naming the real directory, while a plain
 * checkout has a `.git` directory. `undefined` when neither reads as a git dir.
 */
export function gitDirOf(worktree: string): string | undefined {
  const dotGit = join(worktree, ".git");
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (match?.[1] !== undefined) {
      // A worktree's gitdir is `<repo>/.git/worktrees/<slug>`; what a commit writes is the common
      // dir above it.
      const dir = dirname(resolve(worktree, match[1].trim()));
      return basename(dir) === "worktrees" ? dirname(dir) : dir;
    }
  } catch {
    // Not a file: a plain checkout's `.git` is a directory, handled below.
  }
  return existsSync(join(dotGit, "objects")) ? dotGit : undefined;
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
