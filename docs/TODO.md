# TODO

## Done

All work items are complete. D1–D3 were diagnosed 2026-10-06 from the supervisor's
pi session during a live run, then implemented with tests.

### ✅ D1 — `await_response agentId=X` now wakes on messages FROM X, not to X

`PeerMessaging` now resolves `await:<sender>` (and recipient/target) on inbound
PROMPT/RESPONSE/FINAL_REPORT. Kills the 180–240s stalls. Tests: unit
`peer-messaging.test.ts`, integration `await-response.test.ts`.

### ✅ D2 — prompt timeouts raised + configurable

`session.peer_prompt_timeout_ms` (default 120000) drives both `send_prompt` and
`await_response`; `send_prompt` also takes an optional `timeoutMs`. Test: schema
default in `session-schema.test.ts`.

### ✅ D3 — supervisor model switched off OpenCode-only `opencode/big-pickle`

Also tested `opencode/glm-5.3-flash` (402, no funds) and `opencode/glm-5.3` (402).
Set to the funded equivalent `commandcode/z-ai/glm-5.3-flash` in
`task-optimize-first/session.yaml` (verified live).

---

## Run review pass — `task-optimize-first` (S5–S6 remaining)

The "review, improve, optimize, comment" run was stopped by operator instruction
after S2. S1–S2 shipped in the run (`2079cf2`); S3 (`82dbe95`) and S4 (`86c920d`)
were completed afterwards. The run is still **partial**:
`task-optimize-first/final.md` records `status: aborted`, `exit_code: 2`, and the
architecture SVG (S6) was never generated, so the run's global DoD is not met.

| # | Section | Scope | Status |
|---|---------|-------|--------|
| S1 | Protocol boundary | `src/contracts/*`, `src/bus/*` | ✅ done — reviewer APPROVE |
| S2 | Orchestration core | `src/runtime/*`, `src/control/*` | ✅ done — shipped in `2079cf2` |
| S3 | Peer process + pi glue | `src/peer/*`, `src/pi/*` | ✅ done — shipped in `82dbe95` |
| S4 | Lifecycle / artifacts / validation / supervisor | `src/supervisor/*`, `src/artifacts/*`, `src/validation/*` | ✅ done — shipped in `86c920d` |
| S5 | Support infra | `src/budget/*`, `src/herdr/*`, `src/locks/*`, `src/logging/*` | ⏳ not started |
| S6 | Test headers + architecture SVG | `test/**`, `docs/architecture.svg` | ⏳ not started |
| Final | Full `just test` + `just typecheck`, reviewer sign-off, `final.md` | — | ⏳ not started |

### S3 — Peer process + pi glue

**Done** (`82dbe95`). Extracted the peer inbound dispatch into a testable
`handleInboundLine` (`peer-main` CRAP 56→12) and `applySupervisorModel` out of the
extension handler (`extension.ts` CRAP 90→72); deleted JSDoc that restated file
headers in `peer-config`, `peer-harness`, `permission-gate`, `tool-call-logger`,
`web-tool`, `supervisor-usage`. 6 new tests; 310 pass, typecheck clean, fallow
dead-code unchanged at 6.

### S4 — Lifecycle / artifacts / validation / supervisor

**Done** (`86c920d`). Extracted `finalReports()` and reused it in
`Supervisor.collectReports` (removes the duplicated FINAL_REPORT mapping); deleted
class/function JSDoc that restated file headers (`supervisor`, `reconciliation`,
`report-collector`, `final-writer`, `validation-runner`); suppressed fallow's
unused-class-member false positives on the (`reassign|onGlobalBudget|finalize|reconcile`)
policy API (F4). fallow dead-code 6 → 2; the 2 remaining are the entry-point files
(F5, S1 — suppress with `// fallow-ignore-file unused-file` to reach 0).

### S5 — Support infra

Review `src/budget/*`, `src/herdr/*`, `src/locks/*`, `src/logging/*`. Driver:
remove JSDoc blocks that merely restate the file header (same F2 rule as S1/S2);
general header accuracy.

### S6 — Test headers + architecture SVG

Add/settle purpose headers on `test/**` files, and generate the architecture SVG
`docs/architecture.svg` via the `fireworks-tech-graph` skill (F6: missing). This is
the last unmet global-DoD item.

### Final

Re-run full `just test` + `just typecheck`, get reviewer sign-off, and write
`final.md` with `status: success` (or `partial` with the reason).

---

## Original plan — all done

_Sections 1–10 below are the completed pre-run task specifications, retained for
reference. Nothing in them is open._

Ordered by priority (dependency-aware). A "full run" = `just run` in a herdr pane
→ `/mypi-multi-agent session.yaml` → peers spawn and execute in panes → reports
flow back → `final.md` + logs written → exit code.

## Process (applies to every item)

- **TDD**: write red tests first, covering the happy path *and* the failure/regression cases listed. Confirm the failure is for the intended missing behavior, then implement to green.
- **ponytail-review before writing code**: run ponytail-review on the planned diff/design, reconcile (apply) its suggestions, then implement.
- **No live LLM/herdr in tests**: inject mock adapters (model, herdr client, socket) so tests stay deterministic. Real LLM/herdr only in the final E2E.
- After each item: `bun run test` and `bun run typecheck` must be green with zero regressions.

---

## Progress (2026-10-06)

Items 1–8 done (TDD + ponytail, committed/pushed). **230 tests, typecheck clean.**

| # | Item | Commit | Tests |
|---|---|---|---|
| 1 | Real peer harness | `4528f8c` | 205 |
| 2 | Pass full config to peers | `7d1b038` | 212 |
| 3 | Usage + pane status | `d2874d6` | 215 |
| 4 | Budget enforcement live | `834579f` | 219 |
| 5 | final.md + conversation.jsonl | `823f253` | 222 |
| 6 | Distributed file locking | `f0d2b71` | 225 |
| 7 | Validation gates | `ae65a9c` | 229 |
| 8 | Abort wiring | `a575357` | 230 |
| 9 | `await_response` + refinements (shell allowlist gate, `agent_settled` capture, `tool-calls.jsonl`) | `1909ed6` | 246 |
| 10 | Live E2E (herdr + model) — `/finalize` wiring, absolute peer path, `e2e.test.ts` | `e65864b` | 246 + 1 live |

All items complete. `test/e2e/e2e.test.ts` runs the full live chain (config → bus → panes → registration → work → reports → `final.md` → exit 0) when `HERDR_ENV=1`; verified green in a live herdr session (2026-10-06, `deepseek/deepseek-v4-pro`).

Post-first-run (committed/pushed): R1–R3 logging (crash/finalize/supervisor-model-miss), `final.md` cost breakdown (supervisor + per-peer), persistent peer sessions (memory until the ask ends), `web_fetch` tool, and PM-mediated relay prompts. **262 tests, typecheck clean.**

---

## 1. Real peer harness (blocker)

- **Files**: `src/peer/peer-main.ts`, new test under `test/integration/`.
- **Gap**: the `WORK_ORDER` handler is `void runWorkOrder` — it never resolves a model or calls `createAgentSession`, so peers execute nothing.
- **Do**:
  1. Resolve the `--model provider/model` string to a `Model` via the model runtime (`ModelRuntime.getModel(providerId, modelId)`; construct the runtime with `createAgentSession` defaults or `createAgentSessionServices`).
  2. On `WORK_ORDER`, `createAgentSession({ model })`, `session.prompt(action)`, stream `session.subscribe()` text deltas to stdout.
  3. On completion, write a `FINAL_REPORT` envelope over the socket: `{ id, timestamp, sender: agentId, recipient: "supervisor", type: "FINAL_REPORT", payload: { agentId, report: <last assistant text> } }`.
- **Test approach**: inject a fake `runSession(prompt)` (mock model/session) so no live LLM is needed. Assert: WORK_ORDER → session prompt invoked → FINAL_REPORT emitted with the returned text. Also cover: malformed WORK_ORDER, missing `--model`, socket disconnect mid-work.
- **Gotchas**: `createAgentSession` takes a `Model<any>` object, not a string. `session.dispose()` on completion; unsubscribe before dispose.

## 2. Pass full agent config to peers

- **Files**: `src/runtime/runtime.ts` (`spawnPeers`), `src/peer/peer-main.ts`.
- **Gap**: `spawnPeers` passes only `--agent/--bus/--model`; `system_prompt`, `permissions`, `max_cost_usd`, `max_tokens` are dropped.
- **Do**:
  1. `spawnPeers` passes all of: `--system-prompt`, permissions, `max_cost_usd`, `max_tokens` (JSON-arg or a temp config file — pick the one that survives shell quoting).
  2. Peer harness applies permissions via `createAgentSession` tool selection: `edit: false` → no edit/write tools; `shell` policy per `tool-permissions.ts` (`shell:false` → no bash; `shell:true,edit:false` → only `shell_allowlist`).
- **Test**: unit-test the argv/arg building; unit-test the tool-selection mapping (permissions → allowed tool set). No live model.
- **Gotchas**: `createAgentSession({ tools: [...] })`/`noTools` control the active set; a read-only peer should also keep `read` tools.

## 3. Peer feedback loop (usage + status)

- **Files**: `src/peer/peer-main.ts`, `src/runtime/runtime.ts`, `src/herdr/status-adapter.ts` (already exists).
- **Gap**: peers don't report usage or stream status to the collapsed pane.
- **Do**:
  1. Peer reads `message.usage` (`{ totalTokens, cost: { total } }`) from `session.subscribe` (`message_end`/`turn_end`) and emits a usage event over the bus.
  2. Peer calls `herdr pane report-metadata $HERDR_PANE_ID --source <ext> --token state=<STATE> --token cost=<str> --token tokens=<str> --title <task>` on state changes (STARTING→WORKING→DONE). `$HERDR_PANE_ID` is injected by herdr into the pane.
- **Test**: unit-test the status-mapping (state/cost/tokens → `--token` args, already partly covered by `status-adapter.test.ts`); integration-test that usage events arrive on the bus with a mock session.
- **Gotchas**: token names `^[A-Za-z0-9_-]{1,32}$`, values are strings, max 16/call. `--state-label` is herdr lifecycle only — canonical state goes in `--token state=...`.

## 4. Budget enforcement live

- **Files**: `src/runtime/runtime.ts`, `src/budget/*` (exists).
- **Gap**: `UsageAccounting`/`BudgetEnforcer`/`PiUsageAdapter` are synthetic-only; no usage flows in a real run.
- **Do**: wire `PiUsageAdapter` into the Runtime's usage-event handler; on each event run `BudgetEnforcer.check()`; agent threshold → `controlPlane.stopAgent`, global → `controlPlane.stopAll` (FINALIZING).
- **Test**: integration — synthetic usage events over the bus trip the thresholds and emit STOP_AGENT/STOP_ALL. Regression: free model (cost 0) with `max_tokens` still trips; missing-usage logs a gap and doesn't zero.

## 5. Artifacts: final.md + logs

- **Files**: `src/runtime/runtime.ts`, `src/pi/extension.ts`, `src/artifacts/final-writer.ts` + `src/logging/*` (exist).
- **Gap**: `FinalWriter`, `ConversationLog`, `ToolCallLog` are never called.
- **Do**:
  1. On finalization/abort, write `final.md` (outcome/exit_code frontmatter + per-peer reports from `Reconciliation`).
  2. Append orchestration events to `conversation.jsonl` and tool calls to `tool-calls.jsonl` in the ask directory.
- **Test**: integration — a completed mock run leaves `final.md` + both `.jsonl` files with the expected content. Regression: aborted run still writes an `aborted` final.md.

## 6. File locking + edit intent live

- **Files**: peer harness edit path; `src/locks/*` (exist).
- **Gap**: `FileLockManager`/`EditIntentManager` aren't connected to real peer edits.
- **Do**: before an authorized edit, emit `INTENT_TO_MODIFY` and acquire the exact-file lock; release after; `releaseAll` on crash/disconnect. Wire into the peer's edit tools (or a tool wrapper).
- **Test**: unit — the flow (permission check → intent → lock → mutate → release) with the existing lock-manager tests; integration — two peers contend for one file (FIFO). Regression: lock released on disconnect/kill.

## 7. Validation gates live

- **Files**: `src/runtime/runtime.ts`, `src/validation/*` (exist).
- **Gap**: `ChangeDetector` + `runValidation` aren't wired into the run.
- **Do**: mark `ChangeDetector` on any code edit; at finalization run `runValidation(config.validation, changed, exec)`; `validationAllowsSuccess` ANDed with DoD for the exit code.
- **Test**: integration — code-changing run with failing validation can't exit 0; no-code-change run skips the gate. Regression: no config → semantic only.

## 8. Abort wiring

- **Files**: `src/pi/extension.ts`, `src/control/abort.ts` (exists).
- **Gap**: the exit-2 path (`abortSession`) isn't connected to any signal.
- **Do**: on Ctrl-C/session shutdown, run `abortSession` (graceful stop → 10s grace → force-kill → teardown → aborted `final.md` → exit 2).
- **Test**: unit — the sequence with injected sleep (already covered in `abort.test.ts`); integration — signal during a run triggers the path and leaves an aborted final.md.

## 9. `await_response` tool

- **Files**: `src/pi/extension.ts`, `src/runtime/runtime.ts`.
- **Gap**: spec's 4th A2A tool (peer inbound delivery) is unregistered.
- **Do**: register `await_response` so a peer can block on an inbound PROMPT; wire it to inbound `PROMPT` delivery in the peer harness.
- **Test**: integration — peer A `send_prompt`s, peer B `await_response` resolves with the text. Regression: timeout and FINALIZING behavior.

## 10. End-to-end (live herdr + model)

- **Files**: `test/e2e/e2e.test.ts` (skip-gated today).
- **Do**: after 1–9, run the full run against a real herdr session + real models; assert config → bus → panes → registration → work → reports → `final.md` → exit 0, plus the failure scenarios (abort, kill-all, budget).
- **Not unit-testable**; requires `HERDR_ENV=1` and authenticated models for every `model:`/`supervisor_model:` slug.
