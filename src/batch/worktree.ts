/**
 * The worktree seam for one run: what `just prep` does, in code.
 *
 * Two details are load-bearing and were read off the `prep` recipe rather than assumed:
 * the path is `<parent of the repo>/ma-wt-<slug>` and the branch is `task/<slug>`, and a
 * worktree without `web/node_modules` cannot pass `bun run check` because that directory
 * is gitignored and absent from a fresh worktree (design F10).
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Exec = (args: string[], opts?: { cwd?: string }) => Promise<string>;

/**
 * Git exports `GIT_DIR`/`GIT_WORK_TREE` to hooks, and this driver can be started from one.
 * Inheriting them points every call at the caller's repository instead of the worktree
 * being created — which re-inits the real checkout.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }
  return env;
}

const defaultExec: Exec = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd: opts?.cwd, env: cleanGitEnv() }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

export interface CreateWorktreeInput {
  /** The main checkout. A worktree is refused: `git worktree add` must run from the common dir. */
  repoRoot: string;
  /** The configured task directory, e.g. `mypi-tasks`. */
  taskDir: string;
  /** `b-<batch>-t<n>`; also the branch suffix and the directory name. */
  slug: string;
  base?: string;
  exec?: Exec;
  /** Reuse an existing worktree (the `just prep` workflow) instead of refusing it. */
  reuse?: boolean;
}

export interface Worktree {
  path: string;
  branch: string;
}

export function worktreePath(repoRoot: string, slug: string): string {
  return join(dirname(repoRoot), `ma-wt-${slug}`);
}

export async function createWorktree(input: CreateWorktreeInput): Promise<Worktree> {
  const exec = input.exec ?? defaultExec;
  const base = input.base ?? "main";
  const path = worktreePath(input.repoRoot, input.slug);
  const branch = `task/${input.slug}`;

  // `git` answers with the resolved path, and /var is a symlink to /private/var on macOS,
  // so compare realpaths or every run is refused as "inside a worktree".
  const root = realpathSync(input.repoRoot);
  const commonDir = (
    await exec(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root })
  ).trim();
  const mainCheckout = realpathSync(dirname(commonDir));
  if (root !== mainCheckout) {
    throw new Error(`run this from the main checkout (${mainCheckout}), not a worktree (${root})`);
  }
  if (existsSync(path)) {
    // A batch slug carries batch and ticket, so a stale path is a bug to report. `just prep`
    // is re-run against the same name on purpose, and reuses it.
    if (input.reuse !== true) throw new Error(`worktree already exists: ${path}`);
    ensureModules(root, path);
    return { path, branch };
  }

  await exec(["worktree", "add", path, "-b", branch, base], { cwd: root });
  ensureModules(root, path);
  return { path, branch };
}

/**
 * Remove a ticket's checkout after a successful run (#246). The branch stays: it is
 * the deliverable, and the run's artifacts were copied into the batch record before
 * this is called. A worktree that is already gone is not an error — a retried batch
 * and a hand-cleaned checkout both reach here with nothing to do.
 */
export async function removeWorktree(input: {
  repoRoot: string;
  slug: string;
  exec?: Exec;
}): Promise<void> {
  const exec = input.exec ?? defaultExec;
  const path = worktreePath(input.repoRoot, input.slug);
  if (!existsSync(path)) return;
  await exec(["worktree", "remove", "--force", path], { cwd: input.repoRoot });
  // The admin files under .git/worktrees are removed by the command above; prune keeps
  // a stale entry from a crashed removal out of `git worktree list`.
  await exec(["worktree", "prune"], { cwd: input.repoRoot });
}

/**
 * A worktree needs both dependency trees. Copied rather than symlinked: `.gitignore` lists
 * `node_modules/` (a directory rule), so a symlink is untracked — the tree is dirty and
 * `classifyDirtyTree` refuses to launch there.
 */
function ensureModules(root: string, worktreePath: string): void {
  for (const modules of ["node_modules", join("web", "node_modules")]) {
    const source = join(root, modules);
    const target = join(worktreePath, modules);
    if (!existsSync(source) || existsSync(target)) continue;
    // `web/` can be absent from a fresh worktree entirely: it holds only ignored files here.
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, verbatimSymlinks: false });
  }
}

export function installManifest(input: {
  worktree: string;
  taskDir: string;
  slug: string;
  manifestText: string;
}): string {
  const dir = join(input.worktree, input.taskDir, input.slug);
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, "session.yaml");
  writeFileSync(manifest, input.manifestText);
  return manifest;
}
