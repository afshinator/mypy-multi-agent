# TODO — Remaining Work to First Full Run

Ordered by priority (dependency-aware). A "full run" = `just run` in a herdr pane
→ `/mypi-multi-agent session.yaml` → peers spawn and execute in panes → reports
flow back → `final.md` + logs written → exit code.

## Process (applies to every item)

- **TDD**: write red tests first, covering the happy path *and* the failure/regression cases listed. Confirm the failure is for the intended missing behavior, then implement to green.
- **ponytail-review before writing code**: run ponytail-review on the planned diff/design, reconcile (apply) its suggestions, then implement.
- **No live LLM/herdr in tests**: inject mock adapters (model, herdr client, socket) so tests stay deterministic. Real LLM/herdr only in the final E2E.
- After each item: `bun run test` and `bun run typecheck` must be green with zero regressions.

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
