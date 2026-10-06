# Multi-agent orchestration system

# Launch the supervisor in a herdr pane. Inside a pane it runs pi directly;
# outside it splits a pane, starts pi there, and attaches herdr.
run:
    #!/bin/sh
    if [ "${HERDR_ENV:-}" = "1" ]; then
        exec pi --extension ./src/pi/extension.ts --append-system-prompt ./src/pi/supervisor-prompt.md
    else
        pane=$(herdr pane split --direction right --cwd "$PWD" --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
        herdr pane run "$pane" "pi --extension ./src/pi/extension.ts --append-system-prompt ./src/pi/supervisor-prompt.md"
        echo "supervisor launching in pane $pane — attaching herdr (switch to the new pane)"
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
