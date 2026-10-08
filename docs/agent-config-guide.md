# Multi-Agent Config Authoring Guide

This document is a complete reference for creating a `session.yaml` template
config. It is written for an agent that must author a config for a specific
task; it does not assume access to the product spec. For the surrounding facts
(peer tools, the relay model, role shapes, validation) see
`docs/config-authoring-kit.md`.

## 1. What the system is

One interactive **supervisor** agent (the user's pi session) orchestrates a set
of **peer** agents, each running headless in its own herdr pane. They talk over
a local Unix-socket A2A bus. The supervisor decomposes the task, dispatches work
orders, reconciles peer `FINAL_REPORT`s against a global Definition of Done
(DoD), steers/reassigns when there are gaps or contradictions, and ends by
calling the `finalize` tool, which writes `final.md` (its decision record) and
`findings.md` (the raw per-peer reports).

The config file is the *only* input the author controls. Everything else
(models, tools, runtime) is fixed.

Run artifacts land in the ask directory: `conversation.jsonl`,
`tool-calls.jsonl`, `final.md` (decision + costs), `findings.md` (raw peer
reports), and the supervisor's working `plan.md`.

## 2. The config file

One `session.yaml` per task. Validation is strict: unknown fields and invalid
values are rejected at startup (exit code 3). Start from `templates/session.yaml`
and tweak.

### Top-level fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | string | yes | config schema version; use `"1.1"` |
| `session` | object | yes | session-wide settings and budgets |
| `ask` | object | yes | the task and global DoD |
| `agents` | array | yes | the peer roster (1 or more) |
| `bus` | object | no | transport defaults (rarely needed) |
| `validation` | object | no | `commands` run as a gate for code-changing runs |

### `session` fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | — | run id; appears in `final.md` metadata |
| `workspace_root` | string | — | source root peers work in; defaults to the supervisor's cwd (repo root) |
| `supervisor_model` | string | — | the supervisor's model (`provider/model`); defaults to pi's current model |
| `supervisor_system_prompt` | string | — | extra guidance prepended to the supervisor's briefing |
| `max_cost_usd` | number > 0 | — | global ceiling for **peer** spend (the supervisor's own spend is reported in `final.md`, not enforced at runtime) |
| `agent_stop_threshold_percent` | number 1–100 | — | % of an agent's bound that triggers graceful `/stop` |
| `wall_clock_ms` | int > 0 | — | wall-clock budget surfaced in `list_agents` (not auto-enforced) |
| `heartbeat_timeout_ms` | int | 3000 | peer heartbeat deadline |
| `finalization_grace_ms` / `finalization_grace_usd` | — | — | **reserved**: validated but not consumed yet |
| `peer_retry_pause_ms` | int | 30000 | pause before each peer model-call retry |
| `peer_max_retries` | int | 3 | peer retries after the first failed turn (0 = no retry) |
| `peer_prompt_timeout_ms` | int | 120000 | timeout for supervisor `send_prompt` / `await_response` |

### `ask` fields

| Field | Type | Meaning |
|---|---|---|
| `title` | string | short task title |
| `description` | string | what to do, in detail |
| `definition_of_done` | non-empty `string[]` | the work criteria that define "done" |

`definition_of_done` is the most important field. It is a **list of checkable work
criteria** — it defines "done". Before `finalize` the reviewer must attest them:
the supervisor sends the criteria to the reviewer, which replies with a fenced
JSON block holding exactly one `{criterion, result, evidence}` per item. The
run succeeds only if that reviewer block covers every criterion and every result
is `pass` — the supervisor's own claim is not enough. Keep each item specific and
verifiable (e.g. "every complexity hotspot above CRAP 30 is refactored below the
gate"), not vague ("good code").

Output/process requirements — branch created & not merged, `plan.md`,
`findings.md`, per-file header comments, and `validation.commands` —
are the system's **run contract**: always required, checked at `finalize`, and
never written into the DoD. A missing required artifact fails the run. (The
findings diagram, when a task generates one, is a task-owned artifact, not a
system run-contract requirement and never a DoD source.)

The system assumes no stack. `templates/portable.yaml` is the stack-neutral
default; when `/mypi-multi-agent` starts with no `session.yaml`, the extension
scaffolds one from it and fills `validation.commands` from `detectStack(dir)`
(`package.json` scripts, `pyproject.toml`/`requirements.txt`/`setup.py`,
`Cargo.toml`, `go.mod`, with `Makefile`/`justfile` as fallback). Analyzer
suggestions (`fallow`, `biome`, `knip`, `jscpd`, `ruff`, `semgrep`) come from the
same detection; whether a tool is installed is confirmed at run time, not here.

### `agents` fields (per peer)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes, unique | peer identifier (e.g. `fixer`) |
| `title` | string | yes | human role (e.g. `Code Fixer`) |
| `model` | string | yes | `provider/model`, e.g. `deepseek/deepseek-v4-pro` |
| `permissions` | object | yes | `read`/`edit`/`shell` booleans |
| `max_cost_usd` | number > 0 | yes | this peer's dollar allowance |
| `max_tokens` | int > 0 | no | token ceiling; **required if the model is free** |
| `system_prompt` | string | yes | the peer's role instructions |
| `shell_allowlist` | string[] | no | allowed shell commands (see permissions) |
| `capabilities` / `limits` | string[] | no | descriptive metadata, not enforced |

### `bus` fields (optional)

| Field | Type | Default |
|---|---|---|
| `transport` | string | **reserved** (not consumed) |
| `socket_path` | string | **reserved** (the path is derived from the ask directory) |
| `heartbeat_interval_ms` | int | 1000 |

Rule: `heartbeat_timeout_ms >= 2 × heartbeat_interval_ms`.

## 3. Permissions

`permissions` has three booleans. Enforcement is at the tool layer, not the
prompt:

- `read`: file reading/search, plus `web_fetch` (read-only web research: http/https fetches returning truncated text).
- `edit`: file mutation via edit/write tools.
- `shell`: shell execution.

Shell policy (no inference of "safe" commands):

| Config | Shell behavior |
|---|---|
| `shell: false` | all shell blocked |
| `shell: true`, `edit: true` | full shell |
| `shell: true`, `edit: false` | only `shell_allowlist` commands (exact match); empty/missing allowlist = nothing allowed |

`shell_allowlist` is rejected if `shell: false`. A read-only peer that needs a
few commands (e.g. `git status`, `git diff`) uses `shell: true, edit: false`
with an explicit allowlist.

## 4. Budgets and free models

- `max_cost_usd` is per peer; the session `max_cost_usd` is the global ceiling
  for peer spend. The supervisor's own spend is reported in `final.md`, not
  enforced by the runtime budget.
- `agent_stop_threshold_percent` applies to **both** cost% and token%: the
  first bound to reach it triggers graceful `/stop`. They are OR'd.
- A model with **no catalog price** is "free": it costs $0, tokens are still
  counted, and `max_tokens` becomes **required** (the only bound). A config
  with a free model and no `max_tokens` fails validation.

Practical budget rule: sum of peer `max_cost_usd` plus a margin for the
supervisor should stay under `session.max_cost_usd`.

## 5. The supervisor

The supervisor's default "brain" (the orchestration loop) is
`src/pi/supervisor-prompt.md`, sent to the supervisor by the extension when
`/mypi-multi-agent` starts the run. It is not part of this config.

The supervisor's model is `session.supervisor_model` (`provider/model`). When
omitted, pi's current/default model is used. Use `session.supervisor_system_prompt`
to add task-specific guidance — it is prepended to the briefing the supervisor
receives at `/mypi-multi-agent`.

The briefing the supervisor sees is: `[supervisor_system_prompt] + ask + DoD +
roster (id/role/perms/budget) + global budget + the absolute task directory` (the
last line tells it where to write `plan.md` and other per-run files).

## 6. Runtime loop (what the config drives)

1. Decompose the ask into peer-sized work orders, each with a local DoD.
2. Dispatch to the role-fitted peer. Peers do not message each other; the
   supervisor relays between them.
3. As `FINAL_REPORT`s arrive, find gaps, contradictions, and crashes.
4. Steer with targeted follow-ups, or reassign a crashed peer's work.
5. When the DoD is met (or a budget bound forces it): first obtain the
   reviewer's attestation — send it the DoD criteria and require a fenced JSON
   verdict block (one pass/fail + evidence per criterion) — then call the
   `finalize` tool with a `decision` record. It writes `final.md` (decision +
   reviewer criteria + costs) and `findings.md` (raw reports), then tears the run
   down. The run succeeds only if the reviewer attested every criterion `pass`;
   report concisely.

Slash commands: `/mypi-multi-agent [path]`, `/stop-all`, `/stop <agent>`,
`/kill-all`, `/finalize <true|false>`.

Exit codes: `0` success, `1` DoD not satisfied, `2` user abort, `3` config/startup error.

`validation.commands` (optional) is a mechanical gate for code-changing runs:
if code changed, those commands must pass for the run to succeed. Omit it for
read-only/review/research tasks.

## 7. Authoring a template — the recipe

1. **Write the ask.** Title + description + the DoD as a list of checkable
   criteria (each is reviewer-attested at finalize).
2. **Pick 2–4 peers with distinct, non-overlapping roles.** Fewer is better;
   every peer should have one clear job. Good shapes: reviewer + fixer;
   researcher + analyst; architect + auditor.
3. **Set permissions by role.** Read-only for reviewers/researchers; `edit`
   only for peers that must write files; `shell` only if they run commands
   (and then `shell_allowlist` if `edit: false`).
4. **Set budgets.** Assign each peer a `max_cost_usd`; keep the sum plus a
   supervisor margin under `session.max_cost_usd`. Free model → add `max_tokens`.
5. **Write `system_prompt`s.** State the role, its scope, what it must produce,
   and its output format. Be specific; the prompt is the peer's entire identity.
6. **Add `validation` only for code-changing tasks.**
7. **Validate.** The runtime rejects bad configs; if unsure, run with a tiny
   `max_cost_usd` first.

## 8. Existing templates

- `templates/session.yaml` — canonical master with every field commented.
- `templates/pm-led-dev.yaml` — PM writes all code, 2 read-only devs, reviewer.
- `templates/security-review.yaml` — read-only architect + auditor.
- `templates/code-fix.yaml` — reviewer + edit-capable fixer + validation gate.
- `templates/research.yaml` — read-only researcher + analyst.

Copy one, rename it `session.yaml` in the task directory, tweak, run with
`just run` then `/mypi-multi-agent`.
