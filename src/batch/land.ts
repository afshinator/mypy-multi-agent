/**
 * The landing seam for one run: fold a ticket's branch into the run branch, or open and merge
 * PRs. Every function shells to `git`/`gh`; the executor binds them to `repoRoot` and injects the
 * bound functions so tests can stub them without touching git or the network.
 */
import { execFile } from "node:child_process";

export type Exec = (args: string[], opts?: { cwd?: string }) => Promise<string>;

/** Strip git's own env so a call started from a worktree points at the main repo (#461). */
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

const run =
  (bin: string): Exec =>
  (args, opts) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { cwd: opts?.cwd, env: cleanGitEnv() }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });

export const gitExec: Exec = run("git");
export const ghExec: Exec = run("gh");

/** The two binaries plus the checkout every landing command runs in. */
export interface LandSeam {
  git: Exec;
  gh: Exec;
  cwd: string;
}

/** The run-unique branch one batch folds into. */
export function batchBranch(id: string): string {
  return `batch/${id}`;
}

/** The branch a ticket's run delivers. */
export function ticketBranch(slug: string): string {
  return `task/${slug}`;
}

/** Create the run branch from `main`, before the first ticket. */
export async function createBatchBranch(seam: LandSeam, id: string): Promise<void> {
  await seam.git(["branch", batchBranch(id), "main"], { cwd: seam.cwd });
}

/** Advance the run branch to a ticket branch's tip (a fast-forward, no merge commit). */
export async function advanceBatchBranch(seam: LandSeam, id: string, slug: string): Promise<void> {
  await seam.git(["branch", "-f", batchBranch(id), ticketBranch(slug)], { cwd: seam.cwd });
}

/** Push a branch and open a PR to `main`; idempotent on the branch. */
export async function openPR(seam: LandSeam, branch: string, title: string): Promise<void> {
  await seam.git(["push", "-u", "origin", branch], { cwd: seam.cwd });
  const existing = await seam
    .gh(["pr", "view", branch, "--json", "url", "-q", ".url"], {
      cwd: seam.cwd,
    })
    .catch(() => "");
  if (existing.trim() !== "") return;
  await seam.gh(["pr", "create", "--base", "main", "--head", branch, "--title", title], {
    cwd: seam.cwd,
  });
}

/**
 * Wait for a PR's check and merge it (rebase). A fresh PR has no check registered, so poll a
 * bounded number of times before the watch, the same way the `land` recipe does; the watch then
 * blocks until the check passes or fails.
 */
export async function mergePR(
  seam: LandSeam,
  branch: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const checks = await seam.gh(["pr", "checks", branch], { cwd: seam.cwd }).catch(() => "");
    if (checks.trim() !== "") break;
    await sleep(5000);
  }
  await seam.gh(["pr", "checks", branch, "--watch", "--fail-fast"], { cwd: seam.cwd });
  await seam.gh(["pr", "merge", branch, "--rebase", "--delete-branch"], { cwd: seam.cwd });
}
