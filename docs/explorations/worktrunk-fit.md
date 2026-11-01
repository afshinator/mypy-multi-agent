# Worktrunk: fit for this repo and for the batch driver

Assessed 2026-11-01 from the published docs (`https://worktrunk.dev/`): overview, `config`, `hook`,
`switch`, `step`, `list`, `tips-patterns`. Nothing was installed or run — `wt` is not on this machine
and no command in this document was executed. Everything below is either read off those pages or
checked against this repo's code.

## What it is

A CLI that makes git worktrees as cheap as branches, aimed at running several AI agents in parallel.
v0.81.0, MIT OR Apache-2.0, `brew install worktrunk` (also cargo, pacman, conda, winget), shell
integration installed separately and needed only for directory switching.
- **Core:** `wt switch` (switch, create with `--create [--base]`, address by branch or path),
  `wt list` (status, divergence, CI, per-branch summaries), `wt remove`, `wt merge` (commit → squash →
  rebase → hooks → push → cleanup).
- **Layout:** worktrees are addressed by branch; paths come from a user-config template, default
  `.worktrees/{{ branch | sanitize }}`. `--path` overrides one worktree; `wt step relocate` moves it
  back.
- **Automation:** `--no-cd`, `--no-hooks`, `-y/--yes` (skip approval prompts), and `--format json`
  on `switch`, `list` and `step copy-ignored`. `wt list --format=json` emits an envelope with
  `items[].branch` and `items[].worktree.path`.
- **Hooks:** per-project `.config/wt.toml`, per-user `~/.config/worktrunk/config.toml`. Events:
  `pre-switch`, `post-switch`, `pre-start`, `post-start`, `pre-commit`, `post-commit`, `pre-merge`,
  `post-merge`, `pre-remove`, `post-remove`. `pre-*` block, `post-*` run in the background.
- **Project commands need approval on first run** in a checkout; `-y` skips the prompt.
- **`wt step copy-ignored`** copies gitignored files from the primary worktree into another — build
  caches and dependencies — using copy-on-write where the filesystem supports it (APFS, btrfs, XFS).
  `--from`/`--to`/`--dry-run`/`--force`, JSON output.
- **`wt merge` is local:** rebase/squash/push to the target branch in the clone. CI and forge review
  are read for `wt list`, not gated before the merge.

## Where it overlaps with this repo

| This repo today                                                                                                                     | Worktrunk equivalent                                                                | Note                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `just prep <name>` — `git worktree add ../ma-wt-<name> -b task/<name> main`, symlink root `node_modules`, copy the task manifest in | `wt switch --create task/<name> --base main --no-cd --format json` + a project hook | Worktrunk can drive all three steps, path from a template         |
| The two `ln -s node_modules` lines the batch driver needs (root and `web/`)                                                         | `wt step copy-ignored` (all gitignored files, CoW)                                  | Strictly better than symlinks if the dependency is acceptable     |
| `just land` — push, PR, wait for `check`, rebase-merge, refuses on `main`                                                           | `wt merge` — squash/rebase/push locally, then cleanup                               | **Not equivalent.** `wt merge` bypasses the protected-branch gate |
| `herdr worktree create/open/remove`                                                                                                 | Overlapping                                                                         | A third worktree manager in the same flow                         |
| Batch driver: worktree, branch `b-<batch>-t<n>`, manifest, `node_modules` ×2, remove on retry                                       | Same, scriptable via `--format json`                                                | Adds a runtime dependency to the executor                         |

## Fit verdict

**For this repo's human workflow: useful, optional, not urgent.** The current `just prep`/`just task`
pair already produces the right thing; worktrunk's wins are ergonomics (`wt list`, `wt remove`,
`wt switch -`) rather than capability. Adopting it would mean moving worktree paths and teaching a
second tool the branch convention.

**For the batch executor: no, not in v1.** Four reasons, in order of weight:
1. **Path default collides with this repo's guard.** `.worktrees/` inside the checkout is not under
   `taskDirs` or `recordDirs`, so `classifyDirtyTree` would refuse the next `mypi-run` while a batch
   is running. Configurable, but it is exactly the trap #184 was filed for.
2. **A new dependency in the run path.** The executor today needs `git`, `just`, `herdr`, `pi`. Adding
   `brew install worktrunk` to every machine that runs a batch is a real cost for eleven lines saved.
3. **`-y` auto-approves project hooks.** A batch runs after a triage agent has read and written to a
   clone, then executes `<repo>/.config/wt.toml` commands unattended. That is a trust boundary the
   current design does not have.
4. **Three worktree managers.** herdr already owns worktree-backed workspaces; the executor owns
   `../ma-wt-*`; worktrunk would own a third convention and its own state.

**Sequencing:** ship the executor on `git worktree add` + the two symlinks (what the plan says), and
revisit only if (a) worktrees per batch climb past a handful, or (b) cold-start installs become the
dominant cost — in which case lift `wt step copy-ignored` into a single optional pre-step, not a
dependency.

## For other projects

For anyone running 5–10 agents in parallel without an opinionated launcher, this is the tool the git
worktree UX is missing: creation, inventory, cleanup, cache sharing and per-worktree services in one
place, with JSON output for scripting and hooks for the local glue. The two things to check before
adopting anywhere are the same two that matter here: where worktrees land (does that path collide with
an existing guard or ignore rule) and whether project hooks can be trusted unattended.

## What would change this verdict

- A repo whose guard already exempts `.worktrees/` — then reason 1 disappears.
- A dependency policy that already requires worktrunk for other reasons — reason 2 disappears.
- A decision to run the batch unattended on a machine that never has a human at the keyboard _and_
  accepts project-hook execution from agent-touched trees — reason 3 disappears.
