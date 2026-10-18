# Landscape, positioning, and update paths

**Status:** reference, not a spec. The source of truth for work items is the GitHub issue tracker (`gh issue list`). This document records a comparative review (2026-10-16) of `multi-agent` against the pi-native agent extensions and the two desktop front-ends, so the reasoning survives.

## What `multi-agent` excels at

This is the part worth protecting. It is the product.

- **E1 — Auditable supervised runs.** Nothing else has a contract gate: verbatim DoD criteria, designated attester identity, stale-citation rejection, and durable artifacts (`plan.md`, `findings.md`, `final.md`, `conversation.jsonl`, `tool-calls.jsonl`). The extensions produce work; they do not produce a defensible record that the work met a spec.
- **E2 — Live OS-level panes.** Each peer is a real process in a herdr pane with a status title you can watch and `herdr pane read`. In-process subagents are invisible while running; you get a transcript after.
- **E3 — A real control plane.** Per-agent and session budgets, exact-file locking, permission-scoped tools and shell allowlists, model preflight, and the JEV C2 injection gate. `pi-core-subagent` deliberately owns none of this.
- **E4 — Peer mesh, not just leader→child.** The bus routes frames between peers, and the supervisor can reactivate a settled peer (`restart_agent`). A peer opening its own prompt is designed but not reachable end to end yet (issue #41). The extensions are star-topology fan-out with a mailbox bolted on.
- **E5 — A fault taxonomy with recovery.** `AGENT_CRASHED` / `AGENT_UNUSABLE` / `AGENT_STALLED`, heartbeat detection, empty-reply retry, `restart_agent` with a model swap, and wait-failure classification (crashed/stopped/still-working). `pi-core-subagent` bounds children by wall clock; it does not diagnose them.
- **E6 — Heterogeneous roster.** Each peer gets its own model/provider/permissions/thinking level, which is how a reviewer runs on a different model than the author.
- **E7 — It is self-diagnosing.** The latency survey and the artifacts-as-evidence habit. Measure it live rather than trusting a number in this file: `bun run test` (suite size), `fallow health` (health score), `find src -name '*.ts' | xargs wc -l` (source size).

## Where it is weak

- **W1 — Spawn cost.** N `bun` processes + N herdr panes + a unix socket; each pane is created by an `execFile("herdr", ...)`. The heaviest launch path of the options reviewed. `pi-core-subagent` runs children as in-process `AgentSession`s: "no process spawn, no IPC".
- **W2 — No fan-out, no graph.** Work orders are flat dispatches to a fixed roster. No DAG scheduler, and no edges that carry upstream output into a dependent (`pi-dynamic-workflows` fans out to 100s; `pi-core-subagent`'s `needs` edges are data dependencies).
- **W3 — Serialized supervisor.** `await_response` takes a single `agentId`, so the supervisor cannot await several peers at once and peers sit idle (~22% measured) behind the long pole.
- **W4 — No worktrees.** Writers share one tree under exact-file locking. That serializes writers and forgoes per-agent clean diffs, clean merges, and fork/rewind. `pi-gui` and `pi-dynamic-workflows` isolate by worktree.
- **W5 — Weak human review surface.** Review is `git diff` plus markdown. `pi-gui`'s turn-by-turn diff and per-file staging is better.
- **W6 — Coarse cost accounting.** Usage lands at turn completion, so a peer can overshoot its bound mid-turn (issue #6).
- **W7 — Recovery gaps.** Supervisor empty-turn watchdog unbuilt (issue #9), retry-recovery unproven (issue #5), and `AGENT_STALLED` had never fired because thinking deltas count as progress.
- **W8 — Rebuilding commodity mechanics.** The mailbox/graph/verify-command ideas overlap directly with `pi-core-subagent`, which is installed and free.
- **W9 — Provisioning friction.** `session.yaml` + model slugs + permissions + stack detection; preflight catches auth but not credits (5 deaths in one run).

## The extensions compared against

- `@arhen/pi-core-subagent` — in-process subagents, single/parallel/graph modes, `needs` edges that carry upstream output, `Verify:` exit-code discipline, intercom + agent↔agent mailbox.
- `@quintinshaw/pi-dynamic-workflows` — fan-out to 100s of subagents, git-worktree isolation, cost accounting, resume, TUI.
- `pi-zerg-swarm` — agent teams, durable recovery, direct control.
- `PriNova/graphone` — Tauri/Svelte desktop workbench over pi; multi-session UI; multi-agent is *future*; its `services/agent-host` multiplexes many in-process sessions in one process. Dormant since 2026-06.
- `minghinmatthewlam/pi-gui` — desktop app: parallel threads in checkout or worktrees, turn/branch diff review, terminal + files, fork/rewind. Front-end only; no orchestration engine.

## Update paths

- **U1 — Add an in-process peer mode (highest leverage on W1/W2).** Keep herdr panes for peers you want to watch; run non-observed peers as in-process sessions in one host process (the `graphone` `agent-host` pattern, or wrap `pi-core-subagent`). Gives a spectrum — observable vs cheap — instead of one expensive mode.
- **U2 — Worktree-per-writer option (W4).** Aligns with `pi-gui` / `pi-dynamic-workflows`; removes lock contention and buys clean diffs, merges, fork.
- **U3 — `await_any` / `await_all` (W3).** One new supervisor tool; removes the serialization that wastes ~22% of peer time. Cheapest of the real fixes.
- **U4 — Surface live peer state to the supervisor (issue #4).** Kills probe waste.
- **U5 — Close the recovery gaps (#5, #9) and make the stall signal meaningful (W7).**
- **U6 — Per-request metering (#6) and a credit/quota preflight (W9).**
- **U7 — Adopt or wrap `pi-core-subagent` for flat fan-out and graph cases (W8)** instead of extending the in-house bus/scheduler.
- **U8 — Use `pi-gui` as the human review surface (W5)** for run output and solo parallel work.
- **U9 — Use the model probe corpus for peer selection (W6/economics).**

## The strategic fork

The update paths do not all point the same way; pick one before writing more orchestration code.

- **Platform** — own the panes, bus, and scheduler; then U1–U4 are mandatory and U7 is off the table.
- **Control plane** — be the supervisor + DoD + budget + lock layer on top of pi-native agents; then U7 is the headline move and the in-house bus/panes shrink over time, keeping E1/E3/E5 (which nothing else has).

## New direction: run-quality feedback loop

The next investment is not more orchestration; it is learning from past runs. See the "Run-quality feedback loop" epic in the issue tracker. Goal: raise output quality first, speed second, by detecting named mistake classes across the `.mypi` corpus and proving that a change reduced them.

## Caveat

The efficiency comparison (W1/W3) is architectural, not benchmarked. A head-to-head spawn/memory benchmark has not been run.
