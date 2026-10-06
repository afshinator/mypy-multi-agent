# Multi-agent orchestration system

# Launch the interactive supervisor. Run this inside a herdr pane so the
# extension can spawn peers into sibling panes (HERDR_ENV=1).
run:
    pi --extension ./src/pi/extension.ts

# Run the unit/contract/integration test suite.
test:
    bun run test

# Typecheck.
typecheck:
    bun run typecheck

# Debug: run one headless peer directly. The supervisor normally spawns these.
peer agent bus model:
    bun src/peer/peer-main.ts --agent {{agent}} --bus {{bus}} --model {{model}}
