# mypy-multi-agent

Local-first multi-agent orchestration on [pi](https://pi.dev) + [herdr](https://herdr.dev). One interactive **supervisor** agent decomposes a task, spawns headless **peer** agents into herdr panes, and reconciles their results against a Definition of Done.

## Status

Core runtime (L1–L11) is implemented and tested — `bun run test` is 195 passing tests. The Pi extension assembly and peer harness are written and typechecked, but the live herdr/model integration is unverified and the supervisor's reasoning prompt is still TBD. **Not production-usable yet.**

## Prerequisites

- [pi](https://pi.dev) with an authenticated model
- [herdr](https://herdr.dev)
- [bun](https://bun.sh)
- [just](https://just.systems)

## Run

Start pi inside a herdr pane (so the extension can spawn peers into sibling panes):

```sh
just run
```

Then, in the supervisor session, point it at a task:

```
/mypi-multi-agent [path/to/session.yaml]
```

Stop or kill peers at any time:

```
/stop-all          # graceful stop, then finalize
/stop <agent>      # graceful stop one peer
/kill-all          # immediately terminate all peers
```

## session.yaml

One declarative config per task, placed in the ask directory. Start from `templates/session.yaml` — copy it, tweak, done.

```yaml
version: "1.1"

session:
  id: "review-01"
  max_cost_usd: 5.00
  agent_stop_threshold_percent: 85

ask:
  title: "Security review"
  description: "Review JWT auth in ./src/auth.ts"
  definition_of_done: "Reconciled findings with concrete fixes"

agents:
  - id: "reviewer"
    title: "Security Reviewer"
    model: "anthropic/claude-3-7-sonnet"
    permissions:
      read: true
      edit: false
      shell: false
    max_cost_usd: 1.00
    system_prompt: "You are a security reviewer."
```

A free model (no catalog price) must set `max_tokens`; a `shell: true, edit: false` agent needs a `shell_allowlist`. Full config contract: `docs/multi-agent-spec-v1.6.md`.

## Develop

```sh
just test                          # vitest suite
just typecheck                     # tsc --noEmit
just peer <agent> <bus> <model>    # debug a single headless peer
```

Spec: `docs/multi-agent-spec-v1.6.md` · Plan: `docs/multi-agent-implementation-plan-v5.md`
