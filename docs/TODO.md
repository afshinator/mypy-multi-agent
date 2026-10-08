# TODO

## Done — DoD hardening, part 2 (I2, 2026-10-08, done `d44a546`)

### ✅ I2 — reviewer-independent criteria verdicts + run-contract artifact gate — done `d44a546`

I1 shipped the core (DoD = a list of work criteria; `finalize` gates on one verdict
per criterion). Two pieces of the original design remain:

1. **Reviewer independence.** Today the supervisor supplies the `criteria` verdicts
   from its own reading, so a lazy supervisor can self-approve. The reviewer's
   verdicts should be data, not supervisor prose: define an exact JSON verdict block
   (one pass/fail + evidence per criterion) in the prompt, have the extension/runtime
   parse + zod-validate it (reject malformed, re-ask), and gate on the reviewer's
   verdicts. Needs an `a2a-schema.ts` RESPONSE payload field + `peer-harness.ts`
   emission + extension/runtime capture.
2. **Run-contract artifact gate.** I1 moved artifacts/process out of the DoD into the
   system prompt, but nothing checks them in code. Add `checkRunContract()` in
   `src/validation/` (required run-details artifacts present, per-file headers on
   changed files) and fold it into `Runtime.finalize` success.

TDD:
1. Red — reviewer verdict JSON: malformed rejected, valid accepted; a
   supervisor-claimed pass with a reviewer `fail` forces exit 1.
2. Red — run-contract test: a missing required artifact (or a changed src file with no
   header) blocks `dod:true`.
3. Green — RESPONSE payload field + capture, `checkRunContract`, gate wiring.

Gate: `just test` + `just typecheck` green.

---

## Done — "done" must mean the work (I1, 2026-10-08, done `556e249`)

### ✅ I1 — DoD is a list of work criteria; finalize gates on per-criterion verdicts — done `556e249`

Problem (verified against task-optimize-6):
- `ask.definition_of_done` is free prose (`src/contracts/session-schema.ts`), and each
  task's prompt folds *outputs* (branch, `findings.svg`, `plan.md`, headers) into the
  DoD. So "done" = "the files exist", not "the work is done"; one small pass satisfies
  it. `finalize(dod, decision)` takes a boolean the supervisor simply asserts — nothing
  enumerates or checks the DoD item by item.
- Evidence: task-optimize-6 reported `status: success` after spending **$0.55 of $5**
  and changing a handful of lines.

Fix:
- **Config:** `ask.definition_of_done`: `z.string()` → `z.array(z.string()).min(1)` — a
  non-empty list of checkable work criteria. The DoD is only the work.
- **Run contract (system, not per-task):** move the always-required outputs/process out
  of every task's DoD/prompt into code + the default `src/pi/supervisor-prompt.md`:
  branch created & not merged; `findings.svg`, `plan.md`, `findings.md`, `final.md`
  decision present; every changed src file has a header; `validation.commands` green.
  Add `checkRunContract()` in `src/validation/` and call it from `Runtime.finalize`.
- **Gate:** `finalize` gains `criteria: { criterion, result: "pass"|"fail", evidence }[]`
  (one per DoD item). `success = every criterion passes AND the reviewer approved every
  criterion AND the run contract passes`. Missing/failed criteria ⇒ forced exit 1.
- **Reviewer protocol:** the supervisor sends the criteria list to the reviewer; the
  prompt defines an exact JSON verdict block; the bus/extension parses + zod-validates it
  and rejects malformed replies (re-ask). The reviewer's verdict is first-hand data, not
  supervisor prose.
- **Migration:** convert every existing `session.yaml`/template prose DoD to a list
  (`task-optimize-2/3/4/5/6/7`, `templates/*`); document the shape in
  `docs/agent-config-guide.md` and `templates/session.yaml`.

TDD:
1. Red — `test/contracts/session-schema.test.ts`: `definition_of_done` accepts a non-empty
   `string[]`; rejects `[]`/`""`.
2. Red — finalize-gate test: a missing or `fail` criterion forces exit 1; all-pass +
   reviewer approve + contract pass ⇒ exit 0.
3. Red — run-contract test: a missing required artifact (e.g. `findings.svg`) or a
   failing `validation.commands` blocks `dod:true`.
4. Red — reviewer-verdict parse test: malformed JSON rejected; a valid block accepted.
5. Green — schema, briefing, `finalize` tool param, `checkRunContract`, prompt, migration.

Gate: `just test` + `just typecheck` green.

Implemented (`556e249`): `ask.definition_of_done` → non-empty `string[]`; briefing
lists the criteria; `finalize` takes one `{criterion, result, evidence}` per item;
`success = dod AND all criteria pass AND validation`; final.md renders the checklist;
system prompt/config-guide/spec state that artifacts/process are system-owned; every
task/template DoD migrated. **Deferred to I2:** reviewer-independent verdicts and a
run-contract artifact check.

---

## Done — terminal-peer handling gaps (2026-10-08, done `55fffb2`)

Found while watching a live `task-optimize-5` run: dev_b exceeded its per-agent
token ceiling, the budget enforcer stopped it (`STOP_AGENT … reason: "budget
threshold"`), its process exited, and the supervisor then sat on a 300 s
`send_prompt` timeout. Two independent runtime gaps.

### ✅ H1 — budget enforcer re-stops terminal agents and masks other violations — done `55fffb2`

Verified (live `task-optimize-5/run-details/conversation.jsonl` + reproduced):
- Five identical `STOP_AGENT → dev_b` events (`ctl-5`…`ctl-9`), all
  `payload.reason: "budget threshold"`. Only the first was needed.
- `Runtime.enforceBudget()` (`src/runtime/runtime.ts:322`) runs on every
  FINAL_REPORT/RESPONSE (`:487`, `:497`). `BudgetEnforcer.check()`
  (`src/budget/budget-enforcer.ts:34`) iterates `config.agents` with no
  state/liveness filter and returns the FIRST over-threshold agent;
  `ControlPlane.stopAgent()` (`src/control/control-plane.ts:34`) always emits
  `STOP_AGENT` and calls `onStop` → `markStopped`. Once dev_b's cumulative
  tokens passed 85% of `max_tokens` (850k; dev_b logged 422,348 + 168,005 +
  1,037,508 = **1,627,861**), every later usage event returned dev_b again, so
  it re-emitted forever.
- Same "first violation wins" return masks others: reproduced with two
  over-threshold agents — `check()` returned `dev_a` on every call, `dev_b`
  never surfaced.
- Global arm: at ≥100% session cost `enforceBudget` calls `stopAll`, which
  re-emits `STOP_ALL` on every later event (`SessionState.enterFinalizing` is
  idempotent while `FINALIZING`, so it spams rather than throws).

Fix:
- `BudgetEnforcer.check(skip?: ReadonlySet<string>)` — `continue` past any
  agentId in `skip`. Optional, so existing callers/tests are unchanged.
- `Runtime.enforceBudget()` builds `skip` from `this.states` (`"STOPPED"` /
  `"CRASHED"`) and passes it. Do NOT gate the whole method on
  `!session.isActive` — that disables agent-level enforcement for the entire
  FINALIZING window while peers are still running. To stop the global arm
  re-emitting, guard only that branch:
  `else if (this.session.isActive) this.controlPlane.stopAll("global budget")`.
- The `skip` must live inside `check()`; filtering the returned violation in
  `Runtime` would return the same terminal agent forever and still mask others.

Why this is right: a stopped/crashed agent cannot be stopped again; skipping it
advances the "first violation" cursor to the next live over-budget agent,
fixing both the duplicate signal and the masking. Spent cost/tokens still count
toward the global ceiling.

Two consequences to accept:
- Skipping terminal agents means one can no longer mask the ≥100% global arm, so
  `STOP_ALL` can now fire where it previously never tripped. Intended — spent
  cost still counts against the session ceiling.
- The budget path only emits `STOP_AGENT`; it never terminates the pane, and
  `markStopped` latches `STOPPED`. A peer that ignores the signal is therefore
  never re-signalled. Low severity (peer-main exits on `STOP_AGENT`,
  peer-main.ts:152-157); if it must be closed, terminate the pane on an agent
  budget stop rather than re-emitting.

TDD:
1. Red — `test/unit/budget-enforcer.test.ts`: two agents over threshold →
   `check()` returns the first; `check(new Set([first]))` returns the second;
   `check(new Set([first, second]))` returns `undefined`.
2. Red — same file: a terminal agent passed in `skip` is never returned.
3. Red — `test/integration/runtime.test.ts`: trip dev_a's token bound with
   dev_a already `STOPPED`; assert no new `STOP_AGENT` is logged, and a second
   active over-budget agent is still stopped.
4. Green — add the optional `skip` param + the Runtime guard.

Gate: `just test` + `just typecheck` green.

### ✅ H2 — `send_prompt` / `await_response` to a terminal peer block until timeout instead of failing fast — done `55fffb2`

Verified (live + reproduced):
- After dev_b was stopped, the supervisor `send_prompt`'d it (`prompt-5`) →
  `ERROR … correlation-timeout`, `timeoutMs: 300000`: a 5-minute block on a peer
  that was already gone.
- `PeerMessaging.sendPrompt` (`src/runtime/peer-messaging.ts:27`) opens a
  `prompt-N` correlation and emits PROMPT with no state/socket check.
  `Runtime.emit` (`src/runtime/runtime.ts:335`) writes to
  `this.sockets.get(recipient)?.write(…)` — undefined for a stopped peer, a
  silent no-op, so the waiter runs to its timeout.
- `PeerMessaging.awaitResponse` (`:44`) checks only the session phase.
  `markStopped` fails an already-open `await:<id>` (`runtime.ts:307`) but buffers
  nothing, so an await opened after the stop times out. Reproduced:
  `states = {dev_b:"STOPPED"}`, no waiter → `sendPrompt(…,250)` and
  `awaitResponse(…,250)` both rejected only after the full 250 ms.
- In-flight: neither `markCrashed` nor `markStopped` fails an open `prompt-N`
  waiter (`onCrash`, `:77`, touches only `await:` keys), so a `send_prompt` in
  flight when the peer dies also blocks to timeout.

Fix (a first cut that rejected in `Runtime.awaitResponse` before the buffer was
falsified — it discards a buffered report; the logic belongs in `PeerMessaging`,
which already holds `states` and the `await:` buffer):
- Add a `PeerTerminalError` (`name: "PeerTerminalError"`) carrying the reason.
  - `sendPrompt(from, to, …)`: reject immediately (no waiter, no emit) when
    `states.get(to)` is `"STOPPED"`/`"CRASHED"`.
  - `awaitResponse(agentId, …)`: keep the existing **pending lookup FIRST**; only
    after it, if no buffered envelope was consumed and `states.get(agentId)` is
    `"STOPPED"`/`"CRASHED"`, reject fast. This is what preserves the incident's
    own order (dev_b's `FINAL_REPORT` is buffered, then the stop latches
    `STOPPED`; the await must still return the report). Because the reject is
    state-based, a *second* await on a crashed/stopped peer also fails fast —
    today only the first gets the buffered `AGENT_CRASHED` (F6), the rest hang.
    No config check needed: `await_response()` defaults to `"supervisor"`, which
    is never a key in `states`, so it is unaffected.
  - Do NOT reject on "no socket": peers register asynchronously after
    `spawnPeers()`, so a missing socket has legitimate startup cases and is
    already timeout-bounded. Terminal state is the discrete, safe signal.
- Do not mislabel: `Runtime.sendPrompt`/`awaitResponse` map *every* rejection to
  `event: "correlation-timeout"` (`runtime.ts:215-218`, `:227`). Log
  `event: "peer-terminal"` when `err.name === "PeerTerminalError"` and
  `correlation-timeout` otherwise, so the run record shows the real cause (and a
  terminal failure leaves a trace at all).
- Extension: `send_prompt` has no try/catch (`src/pi/extension.ts:221`) unlike
  `await_response`; wrap it and return the message text so the supervisor sees
  `peer dev_b is STOPPED…` as a clean tool result instead of a thrown error.
- In-flight wake: `PeerMessaging` records `correlationId → toAgent` for
  `prompt-N` waiters in `sendPrompt`; add `failPeer(agentId, reason)` that
  rejects them with a `PeerTerminalError`, and call it from
  `markCrashed`/`markStopped` (extend `onCrash`, add `onStopped`). `failPeer`
  must touch ONLY `prompt-N` keys — never `await:` — or F6 breaks
  (`test/unit/peer-messaging.test.ts:132-137`).

Why this is right: the supervisor only learns of a stop on its next tool call,
so that tool result must carry the failure. The pending-first, state-based
reject converts the 300 s hang into an immediate `peer dev_b is STOPPED`,
preserves the buffered report and F6's crash envelope, and fires on every later
attempt rather than only the first.

TDD:
1. Red — `test/unit/peer-messaging.test.ts`: `sendPrompt` to a
   `STOPPED`/`CRASHED` target rejects with `PeerTerminalError` and emits no PROMPT.
2. Red — same file: a buffered `FINAL_REPORT` (`onResponse`) for a peer whose
   state is then `STOPPED` is still returned by `awaitResponse`, not rejected.
3. Red — same file: a `CRASHED` peer's first `awaitResponse` returns the buffered
   `AGENT_CRASHED` (F6), and a *second* `awaitResponse` rejects fast.
4. Red — same file: an open `sendPrompt` waiter rejects when `failPeer(agentId, …)`
   fires; a `failPeer` for a different agent leaves it pending.
5. Red — `test/integration/runtime.test.ts`: a terminal rejection logs
   `event: "peer-terminal"` (not `correlation-timeout`) in `conversation.jsonl`,
   and `awaitResponse("supervisor", …)` still passes.
6. Green — add `PeerTerminalError`, the pending-first state check, the Runtime
   event split, the extension try/catch, and the prompt-target map + `failPeer`.

Gate: `just test` + `just typecheck` green.

---

## Done — supervisor visibility gaps (F1–F8, 2026-10-07)

From the supervisor's own self-report. Everything that relies on a channel the
model does not actually have fails silently; only directly-callable tools give
real feedback. Verified against the code before writing.

### ✅ F1 + F8 — slash-command controls dead; teardown never runs — done `45a38d1`

`registerCommand` makes user-only `/` commands; the model typed `/finalize true`
as text, pi never dispatched it, so `runtime.finalize`/teardown never ran.
Fixed: `finalize`, `stop_all`, `stop`, `kill_all` are now `registerTool` tools;
`supervisor-prompt.md` + `task-optimize-3/session.yaml` point at the tool.

### ✅ F2 — `collect_reports` returns stale/duplicate reports [TDD] — done `ec9c338`

Verified: `Reconciliation.captureFinalReport` stores only the FIRST report per
agent (`if (this.finalReports.has(agentId)) return false`) and `reports()` is
never cleared, so Section-2 reports are dropped and `collect_reports` keeps
returning Section-1 content. `final.md` (FinalWriter) reads the same map, so it
would also get stale first-section reports.

Fix: make `captureFinalReport` latest-wins — `this.finalReports.set(agentId,
envelope)` unconditionally (drop the early-return). Keeps one report per agent
(the latest), fixes staleness, and `final.md` then gets the final conclusions.
The runtime ignores the return value, so the boolean contract can change freely.

TDD: red — `test/unit/reconciliation.test.ts`: a second FINAL_REPORT from the
same agent overwrites the first (`reports()` returns the second).
Green — `captureFinalReport` sets unconditionally.
Gate: `just test` + `just typecheck` green.

### ✅ F3 — budget/cost/token invisible to the supervisor [TDD] — done `ec9c338`

Verified: `list_agents` returns `formatAgents(ids, states)` (id + state only);
`Runtime.accounting` is public and already holds per-agent cost/tokens
(`getAgentCost`/`getAgentTokens`) plus session totals. Threshold enforcement runs
runtime-side (BudgetEnforcer stops peers at 85%), but the supervisor cannot see
any numbers.

Fix: include cost/tokens in `list_agents` output — per agent
`$cost / N tokens` from `runtime.accounting`, plus the session totals and the
session `max_cost_usd` ceiling. Extract the formatter to a pure helper (e.g.
`formatAgentStatus(id, state, cost, tokens)`) so it is unit-testable.

TDD: red — unit test for the formatter (cost/tokens/ceiling rendered; absent
values omitted). Green — extend `list_agents` to use it.
Gate: `just test` + `just typecheck` green.

### ✅ F4 — 30-min wall-clock box has no signal [TDD] — done `ec9c338`

Verified: no wall-clock field in `session-schema.ts`; the box lives only in the
prompt; `Runtime` records no start time and no tool exposes elapsed time, so the
bound is unenforceable from the supervisor's seat.

Fix: add optional `session.wall_clock_ms` (positive int) to the schema; `Runtime`
records `startedAt` on `start()`; expose elapsed/remaining in `list_agents` (or a
small `status` tool). Briefing already names the box; the signal makes it real.

TDD: red — `test/unit/session-schema.test.ts`: `wall_clock_ms` accepted/optional,
invalid values rejected. Green — schema + start-time + list_agents elapsed.
Gate: `just test` + `just typecheck` green.

### ✅ F5 — `dispatch_work_order` acks "dispatched", not "started" [TDD] — done `ec9c338`

Verified: `ControlPlane.dispatchWork` returns true after `sink.emit(WORK_ORDER)`
— it never confirms the peer received or began it. A crash-on-dispatch is
indistinguishable from success until a FINAL_REPORT never arrives.

Fix: after dispatch, the tool returns the peer's current state from
`runtime.states` (e.g. `dispatched to dev_a (state: PENDING)`), and the
supervisor is told to confirm progress via `await_response`/`list_agents`.
Optionally have `dispatchWork` report the state transition.

TDD: red — unit test for the post-dispatch state string (glue; extract a
helper if needed). Green — return state in the tool.
Gate: `just test` + `just typecheck` green.

### ✅ F6 — peer crash not pushed to the supervisor [TDD] — done `ec9c338`

Verified: `markCrashed` sets state CRASHED and emits AGENT_CRASHED via `emit`
(log + socket write only) — it does NOT route through `resolveAwait`, so a
supervisor blocked in `await_response(peer)` times out instead of learning the
peer crashed. `list_agents` does show CRASHED, so only polling catches it.

Fix: when a peer crashes, wake `await_response(<agent>)` with the crash. Add
`PeerMessaging.onCrash(agentId, env)` (or route the AGENT_CRASHED envelope
through `resolveAwait`) so `await:<agent>` resolves with the crash envelope; make
the `await_response` tool render a clear message for a crash payload (it
currently returns `text ?? report ?? ""`, so a crash would read empty).

TDD: red — `test/unit/peer-messaging.test.ts`: `awaitResponse("dev_a")` resolves
when `onCrash("dev_a", …)` fires. Green — implement + crash message.
Gate: `just test` + `just typecheck` green.

### ✅ F7 — `fallow dead-code --dry-run` does not exist (prompt bug) — done `ec9c338`

Verified: `task-optimize-3/session.yaml` supervisor prompt (loop step 4/7) says
`fallow dead-code --dry-run`; fallow 3.31.0 has no such flag (it errored loudly).

Fix: replace with the real command already used elsewhere in the prompt —
`fallow dead-code --format json --quiet`. Grep to confirm no `--dry-run` remains.
Gate: wording review + a live `fallow dead-code --help` check.

### ✅ G — run artifacts into a `run-details/` subdirectory [structural] — done `ec9c338`

Verified: every per-run file lands in the ask dir ROOT today — `Runtime` writes
`conversation.jsonl`, `tool-calls.jsonl`, `.peer-*.json`, the socket, and
`final.md` at `<askDir>/...`; the supervisor writes `plan.md` and the
`fallow-*.json`/`.svg` there too (the briefing says "write plan.md and all
per-run files here"). `.gitignore` and `just cleanup` key off those root paths.

Fix: introduce `<askDir>/run-details/` and write every per-run file there:
- `src/runtime/runtime.ts` — conversation/tool-call logs, `.peer-*.json`, socket,
  final.md paths → `join(askDir, "run-details", ...)`.
- `src/peer/peer-main.ts` — `tool-calls.jsonl` path → run-details (it derives the
  ask dir from the bus socket path).
- `src/pi/extension.ts` briefing + `src/pi/supervisor-prompt.md` + task prompts —
  "write `plan.md` and fallow output in the `run-details/` subdirectory".
- `justfile` `cleanup` — clean `{{dir}}/run-details`; `.gitignore` patterns move
  under `run-details/`.
- Spec `docs/multi-agent-spec-v1.6.md` §14.6 — "the `run-details/` subdirectory of
  the ask directory is the persistent run record"; README artifact paths updated.

Order: LAST — after F2–F7 land, so the move happens over a stable, already-fixed
layout (F3's final.md and F7's fallow files move exactly once).

Gates: `just test` + `just typecheck` green; a live run leaves the task dir root
clean (only `session.yaml` + `run-details/`); `just cleanup <dir>` removes
`run-details/` and leaves `session.yaml`.

---

## Done — peer handoff race + diagnostic surfacing (2026-10-07)

### ✅ C — `await_response` misses reports that arrive before the await opens [TDD] — done `bc99a9b`

Verified problem: `CorrelationRegistry.resolve(id)` is a silent no-op when no
waiter is open (`if (!w) return`). `await_response` opens the `await:<agent>`
waiter AFTER the peer's work is already in flight, so the peer's FINAL_REPORT
that arrives first resolves nothing, and the later `open()` blocks the full
`peer_prompt_timeout_ms` (default 120000). Observed live:
`await_response agentId="dev_a" timeoutMs=240000` → `correlation await:dev_a
timed out` while dev_a's Section-2 FINAL_REPORT was already the last event in
`conversation.jsonl`. D1 (last night) fixed the wake DIRECTION (sender vs
recipient), not this timing race.

Verified fix: buffer the latest envelope per `await:` key in `PeerMessaging`
(do NOT use `Reconciliation.hasReport` — it keeps only the FIRST report per
agent and never clears, so it would return stale Section-1 reports in
Section-2). Inbound envelopes are always peer→supervisor, so buffering
`await:<sender>` and `await:<recipient>` cannot echo the supervisor's own
outbound messages (those go through `emit`, never `resolveAwait`).

- `CorrelationRegistry`: add `hasWaiter(id): boolean { return this.waiters.has(id) }`.
- `PeerMessaging`: add `private pending = new Map<string, A2AEnvelope>()`.
  `resolveAwait` — for each key, if `registry.hasWaiter(key)` deliver via
  `registry.resolve(key, env)`, else `pending.set(key, env)` (latest wins).
  `awaitResponse` — `const waiter = registry.open(key, timeoutMs)` FIRST (registers
  the waiter), then if `pending` has the key, `delete` + `registry.resolve(key,
  pending)`; return `waiter`.
- This closes all three windows: resolve-before-open (buffered → delivered on
  open), resolve-after-open (delivered to the open waiter, NOT buffered → no
  stale double-delivery), and the check/open gap (open registers first, so a
  resolve in the gap delivers to it). Each new report overwrites the buffer, so
  later sections never see earlier sections' reports.

TDD (red → green):
1. Red — `test/unit/peer-messaging.test.ts`: resolveAwait with no open waiter
   buffers; a later `awaitResponse` resolves immediately with that envelope.
2. Red — same file: resolveAwait with an open waiter delivers immediately AND
   leaves no buffer (a second `awaitResponse` still blocks).
3. Red — same file: two pre-await reports → `awaitResponse` returns the LATEST
   (overwrite, not first-wins).
4. Green — implement `hasWaiter` + `pending` buffer.

Gates: `just test` + `just typecheck` green, zero regressions. `send_prompt`
correlations untouched (they open before emit; late-resolve-drop stays correct).

### ✅ D — surface await/send_prompt timeouts in the run record — done `bc99a9b`

Verified problem: await/send_prompt timeouts are tool-level errors caught in
`src/pi/extension.ts` and returned as tool-result text to the supervisor LLM.
`conversation.jsonl` logs only bus envelopes (plus a few ERROR entries), so the
timeout never lands in the run artifacts. It currently only leaks into
`~/.pi/agent/sessions/<dir>/<id>.jsonl` — pi's own session store, not the run
record, and nothing reads it for run diagnostics.

Right place: `conversation.jsonl`. Spec §14.6 lists "crash/failure events" and
the README documents ERROR entries there; it is the per-run append-only
timeline a user opens to diagnose a run. `final.md` is the final outcome (not
per-event); `tool-calls.jsonl` is peer tools only.

Verified fix: wrap the two public `Runtime` methods (they can call the private
`logEntry`, which appends to `conversation.jsonl`):

- `Runtime.awaitResponse` and `Runtime.sendPrompt` — try/catch the
  `peerMessaging` call; on rejection `this.logEntry({ type: "ERROR",
  timestamp: this.now(), event: "correlation-timeout", agentId/to, timeoutMs,
  message: (err as Error).message })`; rethrow so the tool handler still returns
  the error text to the supervisor.

TDD (red → green):
1. Red — `test/integration/runtime.test.ts` (or `budget.test.ts`): awaitResponse
   for a peer that never replies; after the short timeout, `conversation.jsonl`
   contains an ERROR entry with `event: "correlation-timeout"` and the agent id.
2. Red — same for `sendPrompt` timeout.
3. Green — add the two try/catch + logEntry wraps.

Gates: `just test` + `just typecheck` green. `logEntry` already appends
asynchronously via `pendingLogs`; `finalize` flushes, and a live timeout writes
shortly after it occurs (appendFile per entry).

---

## Done — cost/token accounting fixes (2026-10-07)

### ✅ A — RESPONSE path drops peer usage (reviewer = $0) [TDD] — done `908591c`

Verified: `src/peer/peer-harness.ts` PROMPT branch sends `RESPONSE` with
`payload: { agentId, text }` — no `usage`; `src/runtime/runtime.ts` RESPONSE case
only calls `peerMessaging.onResponse` (no `usageAdapter.record`). The
WORK_ORDER → FINAL_REPORT path DOES carry/record usage, so only `send_prompt`'d
peers (the reviewer) are undercounted. SDK `Usage` shape is
`{ totalTokens, cost: { total } }` — the existing reads are correct, so this is a
dropped field, not a shape bug.

Files: `src/contracts/a2a-schema.ts`, `src/peer/peer-harness.ts`,
`src/runtime/runtime.ts`.

TDD (red → green):
1. Red — `test/unit/peer-harness.test.ts`: PROMPT → RESPONSE payload includes
   `usage` equal to `result.usage`.
2. Red — `test/unit/message-validator.test.ts`: RESPONSE payload with `usage`
   validates; without `usage` still validates (field optional).
3. Red — `test/integration/budget.test.ts`: a RESPONSE carrying usage records into
   `UsageAccounting`; a RESPONSE with no usage logs `usage-gap` and records nothing
   (no crash, no zero).
4. Green — `a2a-schema.ts` add
   `usage: z.strictObject({ cost: z.number(), tokens: z.number() }).optional()` to
   RESPONSE (mirror FINAL_REPORT); `peer-harness.ts` add `usage: result.usage`;
   `runtime.ts` RESPONSE case read payload usage and
   `this.usageAdapter.record({ agentId, model, cost: usage?.cost, tokens: usage?.tokens })`
   (mirror the FINAL_REPORT case).

Gates: `just test` + `just typecheck` green, zero regressions. No double-count: a
turn emits FINAL_REPORT (work order) OR RESPONSE (prompt), never both.

### ✅ B — Supervisor must run /finalize (missing final.md costs, supervisor usage, validation, pane teardown) — done `7ffc6c5`

Verified: `conversation.jsonl` has 0 `FINALIZED` events — the supervisor
hand-wrote `final.md` instead of running `/finalize true`. `Runtime.finalize` is
the ONLY writer of the cost frontmatter (`total_cost_usd`/`total_tokens`/
per-agent `cost_usd`/`tokens`), the only place `sumSupervisorUsage` runs, and the
only place the validation gate runs. Peer usage is already recorded in
`UsageAccounting` (FINAL_REPORT path) — it is simply never serialized.

`/finalize` is ALSO the only teardown trigger: its handler runs `runtime.stop()`
→ `paneManager.terminateAll()` → `herdr pane close` per peer. Skipping `/finalize`
is why task-optimize-2 left every peer pane up. The supervisor pane is NOT closed
by `/finalize` — by design it stays (the interactive session) until the user
quits pi; the `just run` wrapper closes it on exit (`pi; herdr pane close`).
Spec note: §19 "Successful Teardown Behavior" says peer panes "collapse to DONE
and remain visible until the user exits"; the implementation closes them instead.
Keep the implementation (matches the user's expectation) and treat the spec
wording as stale unless teardown semantics are revisited.

Fix (prompt — prose, so no unit TDD; gate is wording + live verification):
- `src/pi/supervisor-prompt.md`: state that `/finalize true|false` is the ONLY
  finalization path — it writes final.md (cost breakdown + validation) and tears
  down the run; the supervisor must NEVER hand-write final.md.
- `task-optimize-3/session.yaml` supervisor_system_prompt: replace
  "Finalize after … record in final.md …" with "End the run with
  `/finalize true` (or `/finalize false`). Do not write final.md yourself."

Gates: re-read the wording for ambiguity; a live run must produce a `FINALIZED`
event and a final.md with the cost section (total + per-agent + supervisor).

---

## Done — herdr pane title/model fix (2026-10-07, done `a08676c`)

### Diagnosis

Symptoms: peer panes show no model; the pane title disappears after a peer is pinged.

- **F1 — model never renders.** Peer panes run `bun src/peer/peer-main.ts` (not a
  herdr-recognized agent), so `is_agent_terminal()` is false and the agent sidebar — the
  only surface that renders `--display-agent` / `--token` — excludes them. Only `--title`
  renders on a plain pane's title bar, and it never carried the model.
- **F2 — title wiped after ping.** `herdr pane report-metadata` **replaces** the source's
  stored metadata on every call (`set_agent_metadata` else-branch inserts `title:
  report.title`, i.e. `None` when `--title` is omitted). `peer-main.ts` passes `title` only on
  the STARTING call; WORKING/DONE/STOPPED omit it, so herdr records `title: None` and the
  title clears.

### Fix order

1. `src/peer/peer-main.ts` — pass a full label as `title` on **every** `setStatus` call
   (STARTING/WORKING/DONE/STOPPED): `dev_a · Developer A · <model>` plus state/tokens/cost
   when known. `--title` is the only field that renders on a plain pane.
2. `src/herdr/status-adapter.ts` — route `composeDisplayAgent(...)` into `title` instead of
   `displayAgent`; drop `--display-agent` (dead on these panes).
3. `src/herdr/herdr-client.ts` — remove `--display-agent`; keep `--title`, always emitted.
4. Optional — make peers herdr agents via `pane report-agent --source peer --agent <id>
   --state working|idle|blocked` to unlock the sidebar/state icons. Bigger change; `--title`
   alone fixes visibility.
5. TDD — red tests first: status-adapter test asserts `title` is always set; herdr-client test
   asserts `--title` is always emitted; add a regression test documenting herdr's replace
   semantics (omitting title clears it).
6. Verify — `just test`, `just typecheck`, then a live run to confirm the model shows in the
   pane title and the title survives pings.

### References

- Wrong fix this session: `6679119`, `ee2a076`, `63def86` (moved the label into
  `--display-agent`, removed `--token`).
- herdr 0.9.1: `src/terminal/metadata.rs` (`set_agent_metadata`, replace semantics);
  `src/app/agents.rs` (`agent_info` → `None` unless `is_agent_terminal()`).

---

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

## Run review pass — `task-optimize-first` (all sections done)

The "review, improve, optimize, comment" run was stopped by operator instruction
after S2; S3–S6 were completed afterwards. All six sections are now done:
S1–S2 in the run (`2079cf2`), S3 (`82dbe95`), S4 (`86c920d`), S5 (`bf79fa9`),
S6 (`10140fd`). The run's `final.md` still records `status: aborted`,
`exit_code: 2` (it was aborted), but its global DoD — tests/typecheck green, every
file headed, architecture SVG present — is now met.

| # | Section | Scope | Status |
|---|---------|-------|--------|
| S1 | Protocol boundary | `src/contracts/*`, `src/bus/*` | ✅ done — reviewer APPROVE |
| S2 | Orchestration core | `src/runtime/*`, `src/control/*` | ✅ done — shipped in `2079cf2` |
| S3 | Peer process + pi glue | `src/peer/*`, `src/pi/*` | ✅ done — shipped in `82dbe95` |
| S4 | Lifecycle / artifacts / validation / supervisor | `src/supervisor/*`, `src/artifacts/*`, `src/validation/*` | ✅ done — shipped in `86c920d` |
| S5 | Support infra | `src/budget/*`, `src/herdr/*`, `src/locks/*`, `src/logging/*` | ✅ done — shipped in `bf79fa9` |
| S6 | Test headers + architecture SVG | `test/**`, `docs/architecture.svg` | ✅ done — shipped in `10140fd` |
| Final | Full `just test` + `just typecheck`, reviewer sign-off, `final.md` | — | ✅ done |

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

**Done** (`bf79fa9`). Deleted class/function JSDoc that restated file headers
(`herdr-client` misfiled `CreatePaneOpts` doc, `pane-manager`, `status-adapter`,
`file-lock-manager`, `edit-intent-manager`, `conversation-log`) and dropped stale
L7/L8 layer references (`pi-usage-adapter`, `pricing-resolver`). Comment-only; 310
pass, typecheck clean, fallow dead-code unchanged at 2.

### S6 — Test headers + architecture SVG

**Done** (`10140fd`). All 50 `test/**` files already carried a purpose header.
Generated `docs/architecture.svg` via the `fireworks-tech-graph` skill (Style 1
Flat Icon, `agent` template): user brief → supervisor (pi) → runtime/bus/peers →
reconciliation → `final.md`; clean `render`/`check`, visually inspected. Editable
source committed as `docs/architecture.json`.

### Final

**Done.** `just test` 310 passed / 1 skipped; `just typecheck` clean. Independent
reviewer sign-off: **APPROVE**, no blocking issues. `final.md` written with
`status: success` (it records the run abort and the post-run completion).

### Follow-up resolved — dead `Supervisor` policy methods deleted

The four unwired `Supervisor` methods (`reassign`, `onGlobalBudget`, `finalize`,
`reconcile`) were deleted, along with their tests and the now-unused
`reconciliation` / `detectContradiction` / `onContradiction` deps; `Supervisor`
retains only `onProtocolFault`. The fallow `unused-class-member` suppressions are
gone and `finalReports` is module-private again, so `fallow dead-code` is back to
**2** (the two entry-point files) with no suppressions. 306 tests pass.

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
