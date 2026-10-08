# session.yaml Config Authoring Kit

For an agent (or person) with no prior knowledge of this system who must fabricate
`session.yaml` files: the minimum reading, the facts that are not in one place, and
how to validate a draft. Pair this with `docs/agent-config-guide.md`, which is the
per-field contract.

## 1. Read these, in order

| # | File | Why |
|---|------|-----|
| 1 | `docs/agent-config-guide.md` | field-by-field contract + the authoring recipe |
| 2 | `templates/*.yaml` | six working examples (see §5) — copy and edit |
| 3 | `docs/model-catalog.md` | valid `provider/model` slugs, free vs priced, context/cost |
| 4 | `src/contracts/session-schema.ts` | the authoritative validation (strict Zod); the only real spec of what is accepted |
| 5 | `src/pi/supervisor-prompt.md` | what the supervisor actually does (relay loop, tools, DoD) |
| 6 | `src/peer/peer-config.ts` (`toolsForPermissions`) + `src/pi/tool-permissions.ts` (`canShell`) | exactly what a peer can do per permission |
| 7 | `README.md` → "Do a run" | lifecycle: `mypi-run [dir]`, `/mypi-multi-agent [name|path]`, slash commands, artifacts |

## 2. System facts a config author must know

- **Two tiers.** One interactive **supervisor** (the user's pi session) decomposes the
  ask, dispatches work orders, reconciles reports against the DoD, and writes
  `final.md`. **Peers** run headless in herdr panes.
- **Peers do not message each other.** The supervisor relays. Never write a peer
  `system_prompt` that tells it to contact a sibling.
- **A peer's `system_prompt` is its entire identity** (the `<preamble>`). Pi's default
  coding preamble is *replaced*, not augmented. The global `~/.pi/agent/AGENTS.md` is
  still appended as `<project_context>`, so peer prompts must not repeat house rules.
- **Peer tools by permission** (nothing else is available):
  - `read: true` → `read`, `grep`, `ls`, `find`, `web_fetch`
  - `edit: true` → `+ edit`, `write`
  - `shell: true` → `+ bash` (when `edit: false`, only exact `shell_allowlist` matches)
  - There is **no** `send_prompt`, `dispatch_work_order`, or other agent-to-agent tool on a peer.
- **Free model → `max_tokens` required.** A model is "free" when its catalog input and
  output rates are both 0 (`isFreeCost`). The runtime resolves each slug against the
  catalog and rejects a free model that lacks `max_tokens`.
- **Budgets are OR'd.** `agent_stop_threshold_percent` trips on the first of cost% or
  token% to reach it. `session.max_cost_usd` is the global ceiling (supervisor + peers).
- **The supervisor's brain is already supplied** (`supervisor-prompt.md`).
  `session.supervisor_system_prompt` is *additional* guidance on top of it, not a replacement.
- **The briefing** the supervisor receives is: `[supervisor_system_prompt] + ask + DoD +
  roster (id/role/perms/budget) + global budget + absolute task directory`. It writes
  `plan.md` in that directory's `run-details/` subdirectory.
- **The stack is not assumed.** `validation.commands` is whatever the task declares;
  when a task is scaffolded, it is auto-filled from stack detection (`package.json`
  scripts, `pyproject.toml`/`requirements.txt`, `Cargo.toml`, `go.mod`, `Makefile`,
  `justfile`). A task lives at `.mypi/<task>/session.yaml` and its output at
  `.mypi/<task>/run-details/`.

## 3. Roles

Pick **2–4 peers with distinct, non-overlapping jobs**. Every peer should have one
clear responsibility and a checkable local DoD. A peer that "reviews and fixes and
documents" is three peers in one and will do all three poorly.

Good shapes (see the templates): reviewer + fixer; architect + auditor;
researcher + analyst; PM (supervisor writes) + two read-only designers + reviewer.

A peer `system_prompt` should state: the role, its scope, what it must produce, and the
output format. Keep it specific — it is the whole identity.

Anti-patterns: overlapping roles; a peer with `edit: true` when it only advises; a peer
with `shell: true` and no `shell_allowlist` when `edit: false`; vague DoDs ("good code").

## 4. Validate a draft

- Validation is **strict**: unknown fields and invalid values are rejected at
  `/mypi-multi-agent` (exit code 3). Read `session-schema.ts` for the exact rules;
  cross-field rules include unique agent `id`, `shell_allowlist` requires `shell: true`,
  and `heartbeat_timeout_ms >= 2 × heartbeat_interval_ms`.
- **Check every model slug resolves** before committing: `pi auth check --model <slug>`
  and a live probe `printf 'pong' | pi -p --model <slug>`. Free/OpenCode-only slugs can
  be advertised but unusable from pi (e.g. `opencode/big-pickle` returns a 403).
- To exercise a draft cheaply, set a tiny `session.max_cost_usd`.

## 5. Templates

- `templates/session.yaml` — canonical master, every field commented.
- `templates/portable.yaml` — stack-neutral default; scaffolded automatically when a
  repo has no `session.yaml`, with `validation.commands` auto-filled.
- `templates/pm-led-dev.yaml` — PM writes all code, 2 read-only devs, reviewer.
- `templates/security-review.yaml` — read-only architect + auditor.
- `templates/code-fix.yaml` — reviewer + edit-capable fixer + validation gate.
- `templates/research.yaml` — read-only researcher + analyst.

## 6. Caveats

- **`docs/model-catalog.md` is a dated snapshot.** Slugs and free/priced status drift;
  always verify a slug live before shipping a config.
- **No standalone JSON Schema** — the Zod source in `session-schema.ts` is the contract.
  If you need machine validation, run `parseSessionConfig` (or mirror the schema).
- Run artifacts live in the ask directory's `run-details/` subdirectory:
  `conversation.jsonl`, `tool-calls.jsonl`, `final.md`, and the supervisor's working
  `plan.md`. A scaffolded task is `.mypi/<task>/session.yaml` with output under
  `.mypi/<task>/run-details/`; `.mypi/.gitignore` keeps `run-details/` out of git.
