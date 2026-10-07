# Multi-agent orchestration system

# Launch the supervisor in a dedicated herdr workspace. Inside a pane it runs
# pi directly; outside it creates a workspace, starts pi there, and attaches.
run:
    #!/bin/sh
    if [ "${HERDR_ENV:-}" = "1" ]; then
        exec pi
    else
        pane=$(herdr workspace create --cwd "$PWD" --label mypi-supervisor --focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
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

# Remove gitignored run artifacts under a task directory (leaves session.yaml).
cleanup dir:
    git clean -fX -- {{dir}}
