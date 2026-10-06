# mypy-multi-agent

Local-first multi-agent orchestration on [pi](https://pi.dev) + [herdr](https://herdr.dev). One interactive **supervisor** agent decomposes a task, spawns headless **peer** agents into herdr panes, and reconciles their results against a Definition of Done.

## Status

- **Implemented + tested** (246 unit/contract/integration tests): config schema/validation, A2A protocol, bus framing, registration/heartbeat, correlation/retry, control plane, permissions/locking, budget accounting, reconciliation/finalization, validation gates, `await_response`, shell-allowlist gate, `agent_settled` capture, `tool-calls.jsonl`.
- **Live E2E verified** (`test/e2e/e2e.test.ts`, `HERDR_ENV=1`): real herdr panes + real model, config → bus → panes → registration → work → reports → `final.md` → exit 0.

Run it: inside a herdr pane, `HERDR_ENV=1 E2E_MODEL=<provider/model> bun run test test/e2e/e2e.test.ts` (default model `deepseek/deepseek-v4-pro`).

## Prerequisites

- [pi](https://pi.dev)
- [herdr](https://herdr.dev)
- [bun](https://bun.sh)
- [just](https://just.systems)

## Do a run

1. **Log in to the providers your config uses.** Every `model:` and `supervisor_model:` slug must be resolvable. Run `/login` in pi for each provider, and check exact slugs + current deals in `docs/model-catalog.md`.
2. **Copy a template to `session.yaml`** in the task directory and fill in the `ask`. Start from `templates/session.yaml` or a named template below.
3. **Start the supervisor inside a herdr pane** (so peers can spawn into sibling panes):

   ```sh
   just run
   ```

4. **Launch the run:**

   ```
   /mypi-multi-agent [path/to/session.yaml]
   ```

5. **Watch the peer panes** — collapsed shows state/cost/tokens, expanded shows the live transcript. Control the run:

   ```
   /stop-all           # graceful stop all peers
   /stop <agent>       # graceful stop one peer
   /kill-all           # immediately terminate all peers
   /finalize true      # write final.md (success, exit 0) and tear down
   /finalize false     # write final.md (failure, exit 1) and tear down
   ```

6. **Result:** `final.md` (frontmatter status/exit_code + per-peer conclusions), plus `conversation.jsonl` and `tool-calls.jsonl`, in the ask directory.

## session.yaml

One declarative config per task:

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
    model: "deepseek/deepseek-v4-pro"
    permissions:
      read: true
      edit: false
      shell: false
    max_cost_usd: 1.00
    system_prompt: "You are a security reviewer."
```

A free/unpriced model requires `max_tokens` on that agent; `shell: true, edit: false` requires a `shell_allowlist`. Full contract: `docs/agent-config-guide.md`.

## Templates

- `templates/session.yaml` — master, every field commented
- `templates/pm-led-dev.yaml` — PM writes all code, 2 read-only devs, reviewer
- `templates/security-review.yaml` — read-only architect + auditor
- `templates/code-fix.yaml` — reviewer + edit-capable fixer + validation gate
- `templates/research.yaml` — read-only researcher + analyst

## Models

Exact slugs, per-provider cost, and current deals: `docs/model-catalog.md`.

## Develop

```sh
just test                          # vitest suite
just typecheck                     # tsc --noEmit
just peer <agent> <bus> <model>    # debug a single headless peer
```

Docs: spec `docs/multi-agent-spec-v1.6.md` · plan `docs/multi-agent-implementation-plan-v5.md` · config guide `docs/agent-config-guide.md` · models `docs/model-catalog.md`
