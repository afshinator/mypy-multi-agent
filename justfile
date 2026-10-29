# Multi-agent orchestration system

# Inside a pane it runs pi directly; outside it creates a dedicated herdr workspace,
# starts pi there, and attaches. SHELL_SESSIONS_DISABLE=1 stops macOS Terminal's zsh
# session restore (inherited TERM_SESSION_ID) from printing "Restored session: ...".
# Pass `resume` (or `resume=1`) to start the pane on /mypi-multi-agent --resume; the
# no-arg form is unchanged. This is parsed by hand because just 1.58 has no
# `param=value` argument syntax — it passes those through as literal strings.
#
# Launch the supervisor.
run *args:
    #!/bin/sh
    resume=""
    for a in {{args}}; do
        case "$a" in resume|resume=1|1) resume=1 ;; esac
    done
    if [ "${HERDR_ENV:-}" = "1" ]; then
        if [ -n "$resume" ]; then
            exec pi "/mypi-multi-agent --resume"
        fi
        exec pi
    fi
    pane=$(herdr workspace create --cwd "$PWD" --label mypi-supervisor --focus --env SHELL_SESSIONS_DISABLE=1 | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
    if [ -n "$resume" ]; then
        herdr pane run "$pane" 'pi "/mypi-multi-agent --resume"; herdr pane close "$HERDR_PANE_ID"'
    else
        herdr pane run "$pane" 'pi; herdr pane close "$HERDR_PANE_ID"'
    fi
    exec herdr

# Run the unit/contract/integration test suite.
test:
    bun run test

# Typecheck.
typecheck:
    bun run typecheck

# The every-change gate (issue #123): biome, oxlint, both typechecks, both test
# suites. The tool list lives in the `check` script in package.json, not here.
check:
    bun run check

# Point git at .githooks, so a push runs `check` first. Per clone, once.
hooks:
    git config core.hooksPath .githooks

# The supervisor spawns these; this reproduces one by hand from its own config.
# That config is written by the runtime to <taskDir>/<task>/run-details/.peer-<id>.json
# and removed at teardown, so this only works while that run is live — or against a
# copy taken before it finished.
#
# Debug: run one headless peer.
peer config:
    bun src/peer/peer-main.ts --config {{config}}

# Fault injection: one real peer against a model that fails, printing every bus frame.
alias f := fault
fault model timeout="120":
    bun scripts/fault-inject.ts {{model}} {{timeout}}

# Remove gitignored run artifacts under a task directory (leaves session.yaml).
cleanup dir:
    git clean -fdX -- {{dir}}

# Run the web inspector dev server.
web:
    cd web && bun run dev

# Static build of the web inspector.
web-build:
    cd web && bun run build

# Link node_modules and copy the authored config into the worktree. Author the config
# in the main checkout under the configured write target — taskDirs[0] of
# mypi-multi-agent.yaml, `mypi-tasks` here — as <taskDir>/<name>/session.yaml. The copy
# goes to that same path inside the worktree, the only place /mypi-multi-agent looks.
#
# Prepare a task: create/reuse its worktree on branch task/<name>.
prep name:
    #!/usr/bin/env bash
    set -euo pipefail
    # Always operate on the MAIN checkout, never a worktree.
    root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
    top="$(git rev-parse --show-toplevel)"
    if [ "$top" != "$root" ]; then
        echo "error: run this from the main checkout, not a worktree." >&2
        echo "  cd $root && just prep {{name}}" >&2
        exit 1
    fi
    # Derive the write target from the project's own config rather than hardcoding
    # a layout: the parser here is the same `yaml` + taskDirs contract the launcher uses.
    taskdir="$(cd "$root" && bun -e 'import {readFileSync} from "node:fs";import {parse} from "yaml";const c=parse(readFileSync("mypi-multi-agent.yaml","utf8"));const d=c?.taskDirs?.[0];if(typeof d!=="string"||d===""){console.error("mypi-multi-agent.yaml has no taskDirs[0]");process.exit(1)}process.stdout.write(d)')"
    wt="$(dirname "$root")/ma-wt-{{name}}"
    branch="task/{{name}}"
    cfg="$root/$taskdir/{{name}}/session.yaml"
    [ -f "$cfg" ] || { echo "missing $cfg — author the task config first"; exit 1; }
    if [ -d "$wt" ]; then
        echo "worktree exists: $wt"
    else
        git -C "$root" worktree add "$wt" -b "$branch" main
        [ -e "$wt/node_modules" ] || ln -s "$root/node_modules" "$wt/node_modules"
    fi
    mkdir -p "$wt/$taskdir/{{name}}"
    cp "$cfg" "$wt/$taskdir/{{name}}/session.yaml"
    echo "ready: $wt (branch $branch)"

# Launch a task run: prep, then open a dedicated herdr workspace rooted at the
# worktree, start pi there, and auto-run /mypi-multi-agent <name>. Always a new
# workspace, so the run lives in the worktree either way; from a plain terminal
# it attaches to herdr at the end, from inside herdr it just switches focus.
task name: (prep name)
    #!/usr/bin/env bash
    set -euo pipefail
    root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
    top="$(git rev-parse --show-toplevel)"
    if [ "$top" != "$root" ]; then
        echo "error: run this from the main checkout, not a worktree." >&2
        echo "  cd $root && just task {{name}}" >&2
        exit 1
    fi
    wt="$(dirname "$root")/ma-wt-{{name}}"
    pane=$(herdr workspace create --cwd "$wt" --label "mypi-{{name}}" --focus --env SHELL_SESSIONS_DISABLE=1 | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
    herdr pane run "$pane" "pi \"/mypi-multi-agent {{name}}\"; herdr pane close \"\$HERDR_PANE_ID\""
    if [ "${HERDR_ENV:-}" != "1" ]; then exec herdr; fi
