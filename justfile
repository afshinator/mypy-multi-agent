# Multi-agent orchestration system

# Launch the supervisor. Inside a herdr pane it runs pi directly; outside it
# opens herdr first (then re-run `just run` inside a pane).
run:
    #!/bin/sh
    if [ "${HERDR_ENV:-}" = "1" ]; then
        exec pi --extension ./src/pi/extension.ts --append-system-prompt ./src/pi/supervisor-prompt.md
    else
        echo "not inside herdr — opening herdr; inside a pane run: just run"
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
