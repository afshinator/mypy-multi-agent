# session.yaml Authoring Guide

The complete reference for authoring a `session.yaml`: what the system is, the
field-by-field contract, how to validate a draft, and the known gaps. Written for
an agent (or person) that must fabricate a config with no prior knowledge of the
system. Everything here is checked against the code; `src/contracts/session-schema.ts`
is the authoritative validator.

---

## 1. What the system is

Two tiers:

- **Supervisor** — the user's interactive pi session. Reads the config, spawns
  peers, decomposes the ask into work orders, relays messages between peers,
  reconciles `FINAL_REPORT`s against the global Definition of Done (DoD), and
  ends by calling the `finalize` tool.
- **Peers** — headless pi processes, one per agent, each in its own herdr pane.
  They execute the supervisor's work orders and report back.

They communicate over a local Unix-socket A2A bus. A peer's only channel to the
supervisor is its own lifecycle traffic (registration, heartbeat, `FINAL_REPORT`,
`RESPONSE`); it has **no tool to message another peer**. Peer-to-peer traffic is
relayed by the supervisor. Never write a peer `system_prompt` that tells it to
contact a sibling.

A run's config is the only input the config author controls. Models, tools, and
the supervisor's brain (`src/pi/supervisor-prompt.md`) are fixed.

`session.yaml` is the canonical key. `task:` is not an alias and is rejected as
an unknown top-level field.

### What the config author owns vs what the system owns

| Concern | Owned by |
|---|---|
| Launcher (herdr + pi workspace) | system |
| Bus, peers, budgets, lifecycle, extension | system |
| Stack detection (JS/TS, Python, other) | system |
| Analyzer availability + invocation (fallow, knip, semgrep, ruff, …) | system |
| Supervisor brain (the loop) | system |
| Ask, Definition of Done | task |
| Roster / models / budgets | task |
| `validation.commands` (what "green" means) | task |
| Which analyzers to run + thresholds | task |
| Lint/format policy (biome/ruff/eslint) | task |

`system` = this repo (`src/`, `templates/`); `task` = the `session.yaml` and
prompts in a task directory. Analyzer *selection* and thresholds are task policy;
analyzer *adapters* are system mechanism.

---

## 2. Read these, in order

| # | File | Why |
|---|------|-----|
| 1 | This document | field-by-field contract + the authoring recipe |
| 2 | `templates/*.yaml` | six working examples (see §11) — copy and edit |
| 3 | `docs/model-catalog.md` | valid `provider/model` slugs, free vs priced, cost |
| 4 | `src/contracts/session-schema.ts` | the authoritative strict-Zod validation |
| 5 | `src/pi/supervisor-prompt.md` | what the supervisor actually does (loop, tools, DoD) |
| 6 | `src/peer/peer-config.ts` (`toolsForPermissions`) + `src/pi/tool-permissions.ts` (`canShell`) | exactly what a peer can do per permission |
| 7 | `README.md` → "Do a run" | lifecycle, slash commands, artifacts |

---

## 3. The config file

One `session.yaml` per task. Validation is strict (`z.strictObject` throughout):
unknown fields, wrong types, and invalid values are rejected before any peer
starts. Start from `templates/session.yaml` and tweak.

### Top-level fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | string | yes | config schema version; use `"1.1"` |
| `session` | object | yes | session-wide settings and budgets |
| `ask` | object | yes | the task and global DoD |
| `agents` | array (≥1) | yes | the peer roster |
| `bus` | object | no | transport defaults |
| `validation` | object | no | mechanical gate for code-changing runs |

### `session` fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | — | declarative run id; currently not surfaced in the artifacts |
| `workspace_root` | string | supervisor cwd | cwd of each peer's pi session (the pane itself opens in the task dir) |
| `supervisor_model` | string | pi's current model | `provider/model`; resolved at launch, else an ERROR is logged |
| `supervisor_system_prompt` | string | — | extra guidance prepended to the supervisor briefing |
| `max_cost_usd` | number > 0 | — | global ceiling for **peer** spend (see §5) |
| `agent_stop_threshold_percent` | number 1–100 | — | % of an agent's bound that triggers graceful `/stop` |
| `heartbeat_timeout_ms` | int > 0 | 3000 | peer heartbeat deadline; must be ≥ 2× `bus.heartbeat_interval_ms` |
| `finalization_grace_ms` | int ≥ 0 | 30000 | **reserved** — validated, not consumed |
| `finalization_grace_usd` | number ≥ 0 | 10% of `max_cost_usd` | **reserved** — validated, not consumed |
| `peer_retry_pause_ms` | int ≥ 0 | 30000 | pause before each peer model-call retry |
| `peer_max_retries` | int ≥ 0 | 3 | peer retries after the first failed turn (0 = no retry) |
| `peer_prompt_timeout_ms` | int > 0 | 120000 | timeout for supervisor `send_prompt` / `await_response` |
| `wall_clock_ms` | int > 0 | — | wall-clock budget shown in `list_agents`; **not auto-enforced** |

### `ask` fields

| Field | Type | Meaning |
|---|---|---|
| `title` | string | short task title |
| `description` | string | what to do, in detail |
| `definition_of_done` | non-empty `string[]` | the work criteria that define "done" |

`definition_of_done` is the most important field: a **list of checkable work
criteria**, nothing else. Before `finalize` the reviewer must attest them: the
supervisor sends the criteria to the reviewer, which replies with a fenced JSON
block containing exactly one `{criterion, result, evidence}` per item. The run
succeeds only if the block has exactly one verdict per criterion and every
`result` is `pass` (`src/supervisor/finalization.ts:criteriaSatisfied`). The gate
checks the verdict count, not the criterion strings, and does not verify that the
sender is the designated reviewer — the supervisor is instructed to obtain the
block from the reviewer. Keep each item specific
and verifiable ("every function over 200 lines is split", not "good code").

Output/process requirements — branch created and not merged, `plan.md`,
`findings.md`, per-file header comments, and `validation.commands` — are the
system's **run contract**: always required, checked at `finalize` separately
from the DoD, and never written into the DoD. Today the run contract only
requires `plan.md` to exist in `run-details/` (`src/validation/run-contract.ts`).
A findings diagram, when a task generates one (`findings.excalidraw` via the
excalidraw-diagram skill), is a task-owned artifact: not a run-contract
requirement and never a DoD source.

### `agents` fields (per peer)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string, unique | yes | peer identifier (e.g. `fixer`) |
| `title` | string | yes | human role (e.g. `Code Fixer`) |
| `model` | string | yes | `provider/model`, e.g. `deepseek/deepseek-v4-pro` |
| `permissions` | object | yes | `read`/`edit`/`shell` booleans, all required |
| `max_cost_usd` | number > 0 | yes | this peer's dollar allowance |
| `max_tokens` | int > 0 | no | token ceiling; **required if the model is free** |
| `system_prompt` | string | yes | the peer's role instructions |
| `shell_allowlist` | string[] | no | allowed shell commands; requires `shell: true` |
| `capabilities` / `limits` | string[] | no | descriptive metadata, **not enforced** |

### `bus` fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `transport` | string | — | **reserved** — accepted, not consumed |
| `socket_path` | string | — | **reserved** — the socket is `<askDir>/run-details/.a2a-agent-bus.sock` |
| `heartbeat_interval_ms` | int > 0 | 1000 | supervisor's heartbeat-check poll interval (peers emit on a fixed 1000 ms) |

### `validation` fields

| Field | Type | Meaning |
|---|---|---|
| `commands` | string[] | commands run as a gate when code changed; empty = no gate |

### Cross-field rules

- duplicate agent `id` → rejected;
- `shell_allowlist` present while `permissions.shell !== true` → rejected;
- `heartbeat_timeout_ms < 2 × heartbeat_interval_ms` → rejected;
- a free model (catalog input and output rates both 0) with no `max_tokens` → rejected.

On failure the extension notifies and does **not** start the run. `EXIT.CONFIG_ERROR`
(`3`) is defined in `src/runtime/exit.ts` but is not currently produced by the
extension path.

---

## 4. Permissions

`permissions` has three required booleans. Enforcement is at the pi tool layer,
not in the prompt. `toolsForPermissions` (`src/peer/peer-config.ts`) decides the
peer's tool set:

| Config | Tools enabled |
|---|---|
| `read: true` | `read`, `grep`, `ls`, `find`, `web_fetch` |
| `edit: true` | `+ edit`, `write` |
| `shell: true` | `+ bash` |

There is no `send_prompt`, `dispatch_work_order`, or other A2A tool on a peer.

- `read` also grants `web_fetch` (`src/peer/web-tool.ts`): http/https fetches,
  redirected, truncated at 50 000 chars, 30 s timeout. It gives a peer web
  research without shell.
- `web_fetch` and the file tools are the only capabilities; nothing else is
  available to a peer.

Shell policy is default-deny with no inference of "safe" commands (`canShell` in
`src/pi/tool-permissions.ts`):

| Config | Shell behavior |
|---|---|
| `shell: false` | all shell blocked |
| `shell: true`, `edit: true` | full shell |
| `shell: true`, `edit: false` | only exact `shell_allowlist` matches; empty/missing allowlist = nothing allowed |

`shell_allowlist` is rejected if `shell: false`. A read-only peer that needs a
few commands (e.g. `git status`, `git diff`) uses `shell: true, edit: false`
with an explicit allowlist.

A peer keeps **one persistent pi session** for the whole run; state is not reset
between work orders or follow-ups.

---

## 5. Budgets, free models, and enforcement

- `max_cost_usd` is a per-peer dollar allowance. `agent_stop_threshold_percent`
  applies to **both** cost% and token%: the first bound to reach it triggers a
  graceful `/stop`. The bounds are OR'd (`src/budget/budget-enforcer.ts`).
- `session.max_cost_usd` is the global ceiling and it counts **peer spend only**
  (`UsageAccounting.getSessionCost()` sums peer usage records). The supervisor's
  own spend is summed at finalize for reporting into `final.md` and is **not**
  enforced against the global budget at runtime.
- A model with **no catalog price** is "free" (`isFreeCost`: input rate 0 and
  output rate 0, resolved through pi's model registry). Free means cost $0 and
  tokens still counted, and `max_tokens` becomes **required** — the only bound.
  A config with a free model and no `max_tokens` is rejected.
- `wall_clock_ms` is display-only: `list_agents` prints elapsed/budget, nothing
  stops the run on the clock.

Practical rule: keep the sum of peer `max_cost_usd` under `session.max_cost_usd`.

---

## 6. The supervisor

The supervisor's default brain (`src/pi/supervisor-prompt.md`) is sent by the
extension when `/mypi-multi-agent` starts the run; it is not part of the config
and cannot be replaced. `session.supervisor_system_prompt` is **additional**
guidance prepended to the briefing.

The briefing the supervisor receives is:

```
[supervisor_system_prompt] + ask + DoD + roster (id/title/model/perms/budget)
+ global budget + stop threshold + absolute task directory
```

The last lines tell it to write `plan.md` and all per-run files into the task
directory's `run-details/` subdirectory.

`session.supervisor_model` sets the supervisor's model at launch. If omitted,
pi's current model is used. If the slug does not resolve, the extension notifies
and logs a `supervisor-model` ERROR to `conversation.jsonl`.

---

## 7. Where a run lives

A task lives under `.mypi/<task>/` in the repo being reviewed:

```text
some-repo/
  .mypi/
    .gitignore            # run-details/
    auth/                 # ← task name
      session.yaml
      run-details/
        plan.md
        findings.md
        final.md
        conversation.jsonl
        tool-calls.jsonl
        .peer-<id>.json   # transient, removed on /finalize
```

Only `run-details/` is ignored; `session.yaml` stays trackable.

`/mypi-multi-agent` resolves the config in this order
(`src/pi/session-path.ts`):

1. an explicit path (file, or `<dir>/session.yaml`);
2. an explicit bare name → `.mypi/<name>/session.yaml`;
3. no argument → `./session.yaml`, then tasks under `.mypi/`, then one level of
   subdirectories. Several matches is an error ("specify one");
4. none found → the extension scaffolds `.mypi/<task>/session.yaml` from
   `templates/portable.yaml` and writes `.mypi/.gitignore` (`run-details/`).
   Set the model slugs, then re-run.

Scaffolding fills `validation.commands` from stack detection
(`src/stack/stack-profile.ts`): `package.json` scripts (`test`, `typecheck`,
`lint`, `check`, run with `bun`/`npm`), Python (`ruff check .`, `pytest`),
`Cargo.toml` (`cargo test`), `go.mod` (`go test ./...`), then `Makefile`
(`make test`) / `justfile` (`just test`). First match wins. If detection finds
nothing, `validation.commands` stays `[]`.

### Run artifacts

- `final.md` — frontmatter `status`, `exit_code`, `total_cost_usd`/`total_tokens`,
  `supervisor_cost_usd`/`supervisor_tokens`, and per-agent `cost_usd`/`tokens`;
  body is the supervisor's decision record plus the reviewer's criteria.
- `findings.md` — the raw per-peer `FINAL_REPORT`s, unedited.
- `plan.md` — the supervisor's working plan; the only run-contract artifact.
- `conversation.jsonl` — the orchestration timeline.
- `tool-calls.jsonl` — peer tool executions.
- `.peer-<id>.json` and the bus socket — transient. `/finalize` removes both;
  user abort removes the socket and leaves the `.peer-*.json` files behind for
  inspection.

`final.md` and `findings.md` are written by the system — the `finalize` tool on
normal completion, the abort path on user abort. The supervisor must not
hand-write them.

---

## 8. Finalize gate and validation

`finalize` (`src/runtime/runtime.ts:runSucceeded`) succeeds only when **all** of:

1. the supervisor passes `dod: true`;
2. a peer-attested verdict block covers every DoD criterion `pass` — one verdict
   per criterion, all `pass` (a missing block, a verdict-count mismatch, or one
   `fail` forces exit 1);
3. the mechanical validation gate does not fail (see the caveat below);
4. the run contract holds (`plan.md` exists in `run-details/`).

`final.md` frontmatter `exit_code` is `0` (success), `1` (failure), `2` (user
abort, written by the abort path), or `3` (`EXIT.CONFIG_ERROR`, defined but
currently unused). These codes are recorded in `final.md`; the extension notifies
the user rather than terminating pi with the run's status.

**Validation gate caveat.** `validation.commands` only run when the run changed
code, and "changed" is tracked by `ChangeDetector`, which is flipped solely by an
inbound `INTENT_TO_MODIFY` envelope. Peers edit through pi's tools and do not
emit that envelope (`src/validation/change-detector.ts`), so `hasChanged()` stays
false and the gate currently reports `not-configured`/`skipped` in practice. The
gate is wired and tested; the peer-side signal that would arm it is not.

---

## 9. Control surface

Slash commands (registered in `src/pi/extension.ts`):

```
/mypi-multi-agent [name|path]   # start a run; scaffolds a task when none exists
/stop-all                       # graceful stop all peers + abort supervisor turn
/stop <agent>                   # graceful stop one peer
/kill-all                       # immediate terminate all peers + abort supervisor turn
/finalize <true|false>          # write final.md and tear down
```

The supervisor also has `list_agents`, `dispatch_work_order`, `send_prompt`,
`await_response`, `collect_reports`, `stop_all`/`stop`/`kill_all`, and the
`finalize` tool. `/finalize` removes the transient peer configs and the socket;
a crash/abort leaves them for inspection.

---

## 10. Authoring a template — the recipe

1. **Write the ask.** Title, description, and the DoD as a list of checkable
   criteria (each is reviewer-attested at finalize).
2. **Pick 2–4 peers with distinct, non-overlapping roles.** Fewer is better;
   one clear job per peer. Good shapes: reviewer + fixer; researcher + analyst;
   architect + auditor; PM (supervisor writes) + two read-only designers +
   reviewer.
3. **Set permissions by role.** Read-only for reviewers/researchers; `edit` only
   for peers that must write files; `shell` only if they run commands (and then
   `shell_allowlist` if `edit: false`).
4. **Set budgets.** Each peer gets a `max_cost_usd`; keep the peer sum under
   `session.max_cost_usd`. Free model → add `max_tokens`.
5. **Write `system_prompt`s.** State the role, scope, what it must produce, and
   the output format. The prompt is the peer's entire identity: pi's default
   coding preamble is *replaced*, not augmented. Global `~/.pi/agent/AGENTS.md`
   is still appended as project context, so do not repeat house rules.
6. **Add `validation` only for code-changing tasks** (see the §8 caveat).
7. **Validate.** Strict Zod runs at `/mypi-multi-agent`. Check every model slug
   resolves first: `pi auth check --model <slug>` and a live probe
   `printf 'pong' | pi -p --model <slug>`.
8. **Run it cheaply.** Set a tiny `session.max_cost_usd` to exercise a draft.

Anti-patterns: overlapping roles; a peer with `edit: true` that only advises;
`shell: true` with no `shell_allowlist` when `edit: false`; vague DoDs ("good
code"); a peer prompt that tells it to contact a sibling.

---

## 11. Templates

- `templates/session.yaml` — master template; the common fields are commented
  (it does not show every field: `wall_clock_ms`, `capabilities`, `limits`, and
  `bus.socket_path` are omitted).
- `templates/portable.yaml` — stack-neutral default; scaffolded automatically
  when a repo has no `session.yaml`, with `validation.commands` auto-filled.
- `templates/pm-led-dev.yaml` — PM (supervisor) writes all code, 2 read-only
  designers, reviewer.
- `templates/security-review.yaml` — read-only architect + auditor.
- `templates/code-fix.yaml` — reviewer + edit-capable fixer + validation gate.
- `templates/research.yaml` — read-only researcher + analyst.

Copy one to `.mypi/<task>/session.yaml`, tweak, then launch with `mypi-run [dir]`
(or `bun run start [dir]` from inside this repo) and run `/mypi-multi-agent`.
A bare task name resolves to `.mypi/<name>/`.

---

## 12. Caveats

- **`docs/model-catalog.md` is a dated snapshot.** Slugs and free/priced status
  drift; verify a slug live before shipping a config.
- **No standalone JSON Schema.** The Zod source in `session-schema.ts` is the
  contract. For machine validation, run `parseSessionConfig` or mirror the schema.
- **Supervisor spend is reported, not enforced** (§5).
- **The validation gate is currently inactive** (§8).
- **Reserved fields** (`bus.transport`, `bus.socket_path`,
  `session.finalization_grace_ms`, `session.finalization_grace_usd`) validate but
  do nothing yet.
- **`capabilities` / `limits` are metadata**, not enforced behavior.
