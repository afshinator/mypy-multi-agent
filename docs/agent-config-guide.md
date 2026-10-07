# Multi-Agent Config Authoring Guide

This document is a complete reference for creating a `session.yaml` template
config. It is written for an agent that must author a config for a specific
task; it does not assume access to the product spec.

## 1. What the system is

One interactive **supervisor** agent (the user's pi session) orchestrates a set
of **peer** agents, each running headless in its own herdr pane. They talk over
a local Unix-socket A2A bus. The supervisor decomposes the task, dispatches work
orders, reconciles peer `FINAL_REPORT`s against a global Definition of Done
(DoD), steers/reassigns when there are gaps or contradictions, and writes
`final.md` when done.

The config file is the *only* input the author controls. Everything else
(models, tools, runtime) is fixed.

Run artifacts land in the ask directory: `conversation.jsonl`,
`tool-calls.jsonl`, `final.md`.

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

### `session` fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | — | run id; appears in `final.md` metadata |
| `workspace_root` | string | — | source root peers work in; defaults to the supervisor's cwd (repo root) |
| `supervisor_model` | string | — | the supervisor's model (`provider/model`); defaults to pi's current model |
| `supervisor_system_prompt` | string | — | extra guidance prepended to the supervisor's briefing |
| `max_cost_usd` | number > 0 | — | global dollar budget (supervisor + all peers) |
| `agent_stop_threshold_percent` | number 1–100 | — | % of an agent's bound that triggers graceful `/stop` |
| `heartbeat_timeout_ms` | int | 3000 | peer heartbeat deadline |
| `finalization_grace_ms` | int | 30000 | time grace after finalization begins |
| `finalization_grace_usd` | number | 10% of `max_cost_usd` | cost grace after finalization begins |
| `peer_retry_pause_ms` | int | 30000 | pause before each peer model-call retry |
| `peer_max_retries` | int | 3 | peer retries after the first failed turn (0 = no retry) |
| `peer_prompt_timeout_ms` | int | 120000 | timeout for supervisor `send_prompt` / `await_response` |

### `ask` fields (all required strings)

| Field | Meaning |
|---|---|
| `title` | short task title |
| `description` | what to do, in detail |
| `definition_of_done` | concrete, checkable success criteria |

The DoD is the most important field: the supervisor keeps looping until it is
met (or a bound forces finalization). Make it specific and verifiable
("tests pass and reviewer approves") rather than vague ("good code").

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
| `transport` | string | `unix` |
| `socket_path` | string | `<ask-dir>/.a2a-agent-bus.sock` |
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
  and includes the supervisor's own usage.
- `agent_stop_threshold_percent` applies to **both** cost% and token%: the
  first bound to reach it triggers graceful `/stop`. They are OR'd.
- A model with **no catalog price** is "free": it costs $0, tokens are still
  counted, and `max_tokens` becomes **required** (the only bound). A config
  with a free model and no `max_tokens` fails validation.

Practical budget rule: sum of peer `max_cost_usd` plus a margin for the
supervisor should stay under `session.max_cost_usd`.

## 5. The supervisor

The supervisor's default "brain" (the orchestration loop) is
`src/pi/supervisor-prompt.md`, appended at launch (`just run`). It is not part
of this config.

The supervisor's model is `session.supervisor_model` (`provider/model`). When
omitted, pi's current/default model is used. Use `session.supervisor_system_prompt`
to add task-specific guidance — it is prepended to the briefing the supervisor
receives at `/mypi-multi-agent`.

The briefing the supervisor sees is: `[supervisor_system_prompt] + ask + DoD +
roster (id/role/perms/budget) + global budget`.

## 6. Runtime loop (what the config drives)

1. Decompose the ask into peer-sized work orders, each with a local DoD.
2. Dispatch to the role-fitted peer. Peers may `send_prompt` each other.
3. As `FINAL_REPORT`s arrive, find gaps, contradictions, and crashes.
4. Steer with targeted follow-ups, or reassign a crashed peer's work.
5. When the DoD is met (or a budget/time bound forces it): `/stop-all`, write
   `final.md`, report concisely.

Slash commands: `/mypi-multi-agent [path]`, `/stop-all`, `/stop <agent>`,
`/kill-all`.

Exit codes: `0` success, `1` DoD not satisfied, `2` user abort, `3` config/startup error.

`validation.commands` (optional) is a mechanical gate for code-changing runs:
if code changed, those commands must pass for the run to succeed. Omit it for
read-only/review/research tasks.

## 7. Authoring a template — the recipe

1. **Write the ask.** Title + description + a checkable DoD.
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
- `templates/security-review.yaml` — read-only architect + auditor.
- `templates/code-fix.yaml` — reviewer + edit-capable fixer + validation gate.
- `templates/research.yaml` — read-only researcher + analyst.

Copy one, rename it `session.yaml` in the task directory, tweak, run with
`just run` then `/mypi-multi-agent`.
