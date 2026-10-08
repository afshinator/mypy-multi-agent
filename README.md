# mypy-multi-agent

Local-first multi-agent orchestration on [pi](https://pi.dev) + [herdr](https://herdr.dev). One interactive **supervisor** agent decomposes a task, spawns headless **peer** agents into herdr panes, and reconciles their results against a Definition of Done.

## Status

- **Implemented + tested** (306 unit/contract/integration tests): config schema/validation, A2A protocol, bus framing, registration/heartbeat, correlation/retry, control plane, permissions/locking, budget accounting, reconciliation/finalization, validation gates, `await_response`, shell-allowlist gate, `agent_settled` capture, `tool-calls.jsonl`, persistent peer sessions, `web_fetch`, `final.md` decision record + cost breakdown, `findings.md` raw reports, crash/finalize logging, architecture diagram (`docs/architecture.svg`).
- **Live E2E verified** (`test/e2e/e2e.test.ts`, `HERDR_ENV=1`): real herdr panes + real model, config → bus → panes → registration → work → reports → `final.md` → exit 0.

Run it: inside a herdr pane, `HERDR_ENV=1 E2E_MODEL=<provider/model> bun run test test/e2e/e2e.test.ts` (default model `deepseek/deepseek-v4-pro`).

## Prerequisites

- [pi](https://pi.dev)
- [herdr](https://herdr.dev)
- [bun](https://bun.sh)
- [just](https://just.systems) (optional — the launcher is `bun run start`; `just` only fronts the test/typecheck aliases)
- [biome](https://biomejs.dev) (CLI; `task-optimize-*` prompts run `biome check`)
- Skills (globally installed; templates reference them by name):
  - `ponytail` (npm: `@dietrichgebert/ponytail`)
  - `caveman` (https://github.com/JuliusBrussee/caveman)
  - `fallow`
  - `excalidraw-diagram` (npm: `@excalidraw-skill-pack/core` + renderer `@excalidraw-skill-pack/render`)

## Activate globally (one time)

Add the extension to `~/.pi/agent/settings.json` so `/mypi-multi-agent` loads in
every pi session regardless of directory:

```json
"extensions": ["/absolute/path/to/mypy-multi-agent/src/pi/extension.ts"]
```

Keep the repo at that path (it is the system's home — the extension resolves the
peer harness and supervisor prompt relative to itself).

## Do a run

1. **Log in to the providers your config uses.** Every `model:` and `supervisor_model:` slug must be resolvable. Run `/login` in pi for each provider, and check exact slugs + current deals in `docs/model-catalog.md`.
2. **Get a `session.yaml`.** Start from `templates/session.yaml`, a named template below, or the stack-neutral `templates/portable.yaml`. Drop it in the target repo (or one level down) and fill in the `ask`, roster, and model slugs. If you launch the extension with none present, it scaffolds `session.yaml` from `templates/portable.yaml` and auto-fills `validation.commands` from stack detection.
3. **Start the supervisor** — opens a dedicated herdr workspace and starts pi there:

   ```sh
   bun run start              # or: just run
   bun run start ../other-repo   # run against a different repo
   ```

   The extension is registered globally in `~/.pi/agent/settings.json`, so
   `/mypi-multi-agent` is available in every pi session regardless of directory.
   The pane closes itself when you quit pi.

4. **Launch the run** (omit the path to auto-find `session.yaml` in the current
   directory or one level down):

   ```
   /mypi-multi-agent [path/to/session.yaml]
   ```

5. **Watch the peer panes** — collapsed shows role/model/state/cost/tokens, expanded shows the live transcript. Control the run:

   ```
   /stop-all           # graceful stop all peers + abort supervisor turn
   /stop <agent>       # graceful stop one peer
   /kill-all           # immediately terminate all peers + abort supervisor turn
   /finalize true      # write final.md (exit 0), stop peers, remove transient files
   /finalize false     # write final.md (exit 1), stop peers, remove transient files
   ```

6. **Result:** `final.md` (frontmatter status/exit_code + cost breakdown; body is the supervisor's decision record) and `findings.md` (the raw per-peer reports), plus `conversation.jsonl` and `tool-calls.jsonl`, in the ask directory.

   `/finalize` also removes the transient files (`.peer-*.json` peer configs and
   the socket). On a crash/abort they are left in place for inspection.

## Reading the logs

All artifacts land in the ask directory's `run-details/` subdirectory.

- `conversation.jsonl` — the orchestration timeline, one JSON line per event in order:
  - `AGENT_REGISTER` — a peer connected
  - `WORK_ORDER` — a task was dispatched
  - `FINAL_REPORT` — a peer finished and reported
  - `AGENT_CRASHED` — a peer died (`reason` is `heartbeat timeout` or `disconnected`)
  - `STOP_AGENT` / `STOP_ALL` / `KILL_ALL` — lifecycle signals fired
  - `ERROR` — a malformed frame, a supervisor-model miss, or an await/send_prompt timeout (`correlation-timeout`)
  - `FINALIZED` — the run ended, with `outcome` and `exitCode`
- `tool-calls.jsonl` — peer tool executions (`read`/`edit`/`bash`/`web_fetch`), one line per call.
- `final.md` — outcome + decision: frontmatter `status`, `exit_code`, `total_cost_usd`/`total_tokens`, `supervisor_cost_usd`/`supervisor_tokens`, and per-agent `cost_usd`/`tokens`; the body is the supervisor's decision record (per-section dev_a vs dev_b tension, the reviewer's verdict, and the call made).
- `findings.md` — the raw per-peer FINAL_REPORTs, unedited.
- `plan.md` — the supervisor's working plan (section table + todo); the briefing tells it to write this in the ask directory.
- Peer panes (`herdr pane read <pane-id>`) — live transcript; `model not found` and crash stderr show up here.
- Supervisor reasoning lives in the pi session transcript (its `dispatch_work_order` / `collect_reports` calls are not in `tool-calls.jsonl`).

### Diagnosing a stall

- No `AGENT_REGISTER` for a peer → it never connected; read that peer's pane for `model not found: <slug>`.
- `WORK_ORDER` but no `FINAL_REPORT` → still working, or it crashed mid-work (look for `AGENT_CRASHED`).
- `FINAL_REPORT`s present but no `final.md` / no `FINALIZED` line → the supervisor never ran `/finalize true|false`.

## session.yaml

One declarative config per task:

```yaml
version: "1.1"

session:
  id: "review-01"
  max_cost_usd: 5.00
  agent_stop_threshold_percent: 85
  # Optional peer model-call retry: pause 30s before each retry, up to 3 retries.
  peer_retry_pause_ms: 30000
  peer_max_retries: 3
  # Optional timeout for send_prompt/await_response (default 120000).
  peer_prompt_timeout_ms: 120000

ask:
  title: "Security review"
  description: "Review JWT auth in ./src/auth.ts"
  definition_of_done:
    - "Reconciled findings with concrete fixes"

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

A free/unpriced model requires `max_tokens` on that agent; `shell: true, edit: false` requires a `shell_allowlist`. A `read: true` peer also gets `web_fetch` (read-only web research) and keeps one persistent session for the whole run. Full contract: `docs/agent-config-guide.md`.

## Templates

- `templates/session.yaml` — master, every field commented
- `templates/portable.yaml` — stack-neutral default; scaffolded automatically when a repo has no `session.yaml`, with `validation.commands` auto-filled from stack detection
- `templates/pm-led-dev.yaml` — PM writes all code, 2 read-only devs, reviewer
- `templates/security-review.yaml` — read-only architect + auditor
- `templates/code-fix.yaml` — reviewer + edit-capable fixer + validation gate
- `templates/research.yaml` — read-only researcher + analyst

## Models

Exact slugs, per-provider cost, and current deals: `docs/model-catalog.md`.

## Just aliases

```sh
just run                           # launch the supervisor in a dedicated herdr workspace
just test                          # vitest suite
just typecheck                     # tsc --noEmit
just peer <agent> <bus> <model>    # debug a single headless peer
just cleanup <dir>                 # delete gitignored run artifacts under <dir> (keeps session.yaml)
```

## Develop

Docs: spec `docs/multi-agent-spec-v1.6.md` · plan `docs/multi-agent-implementation-plan-v5.md` · config guide `docs/agent-config-guide.md` · config authoring kit `docs/config-authoring-kit.md` · models `docs/model-catalog.md`
