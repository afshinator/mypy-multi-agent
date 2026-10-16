# Multi-agent orchestration system

# Launch the supervisor in a dedicated herdr workspace. Inside a pane it runs
# pi directly; outside it creates a workspace, starts pi there, and attaches.
# SHELL_SESSIONS_DISABLE=1 stops macOS Terminal's zsh session restore (inherited
# TERM_SESSION_ID) from printing "Restored session: ..." in the pane.
run:
    #!/bin/sh
    if [ "${HERDR_ENV:-}" = "1" ]; then
        exec pi
    else
        pane=$(herdr workspace create --cwd "$PWD" --label mypi-supervisor --focus --env SHELL_SESSIONS_DISABLE=1 | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
        herdr pane run "$pane" 'pi; herdr pane close "$HERDR_PANE_ID"'
        exec herdr
    fi

# Run the unit/contract/integration test suite.
test:
    bun run test

# Typecheck.
typecheck:
    bun run typecheck

# Debug: run one headless peer directly. The supervisor normally spawns these.
peer agent bus model:
    bun src/peer/peer-main.ts --agent {{agent}} --bus {{bus}} --model {{model}}

# Fault injection: one real peer against a model that fails, printing every bus frame.
alias f := fault
fault model timeout="120":
    bun scripts/fault-inject.ts {{model}} {{timeout}}

# Remove gitignored run artifacts under a task directory (leaves session.yaml).
cleanup dir:
    git clean -fdX -- {{dir}}

# Prepare a task: create/reuse the worktree for <name> on branch task/<name>,
# link node_modules, and copy the authored config into it. Author the config in
# the main checkout at .mypi/<name>/session.yaml — that is the single source.
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
    wt="$(dirname "$root")/ma-wt-{{name}}"
    branch="task/{{name}}"
    cfg="$root/.mypi/{{name}}/session.yaml"
    [ -f "$cfg" ] || { echo "missing $cfg — author the task config first"; exit 1; }
    if [ -d "$wt" ]; then
        echo "worktree exists: $wt"
    else
        git -C "$root" worktree add "$wt" -b "$branch" main
        [ -e "$wt/node_modules" ] || ln -s "$root/node_modules" "$wt/node_modules"
    fi
    mkdir -p "$wt/.mypi/{{name}}"
    cp "$cfg" "$wt/.mypi/{{name}}/session.yaml"
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
