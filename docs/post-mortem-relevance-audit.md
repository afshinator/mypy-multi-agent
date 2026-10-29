# Post-mortem-03 relevance audit

Audits whether the 20 recommended changes in
`mypi-tasks/post-mortem-03/run-details/findings-summary.md` §6 still describe open
defects in the live tree (`templates/*.yaml`, `src/`), or have since been implemented
or made moot. Primary sources only: git history and the current files.

## 1. Timeline

Target-task dates, verified from the run-details `final.md` mtimes:

| Target run                       | `final.md` mtime | Matches claim |
| -------------------------------- | ---------------- | ------------- |
| `mypi-tasks/jev-c2-closeout`     | Oct 14 14:30     | yes (Oct 14)  |
| `mypi-tasks/r1-fixes`            | Oct 17 14:39     | yes (Oct 17)  |
| `mypi-tasks/04-inspector-server` | Oct 20 19:44     | yes (Oct 20)  |

Relevant change history since (from `git log --since=2026-10-13`, repo root):
- `Oct 14 0812e30` — `fix(runtime): drop a peer's buffered reply when a new request is sent (F1)` → rec 16.
- `Oct 14 93f3ad2` — `docs(quality): the reviewer returns the ponytail ledger, the supervisor writes it (F3)` → rec 9.
- `Oct 14 71c7ba4` — `fix(peer): a retry is not progress, so a wedged peer can be flagged stalled (F2)` → rec 15.
- `Oct 14 a9cd25a` — `feat(gate): reject an attestation whose cited evidence went stale (O2)` → rec 10 (partial).
- `Oct 17 15bd9fd` — `feat(peer): lock files around edit/write so two peers cannot write one file (fixes #40)` → rec 13.
- `Oct 17 8c45abb` — `fix(peer): block non-public hosts in web_fetch (#30)` → rec 5.
- `Oct 17 86d6f33` — `fix(supervisor): refuse legacy resume without accounting boundary (#35)` → rec 4.
- `Oct 21 4ce71e5` — `docs: analyzer gates are regression-relative, never absolute numbers` → rec 19.
- `Oct 21 b1577dd` — `feat: guard task runs against discarding uncommitted work (#98)` → rec 14 (partial, dirty-tree guard only).
- `Oct 28 e00e043` — `Stop the harness retrying a provider error the SDK already called terminal` → rec 14 (classification half).
- `Oct 28 4d96818 / cfd5924` — `Normalize DoD criteria before the identity comparison (fix #118)` → rec 10 (verbatim matching).

## 2. Status of the 20 recommendations

Status key: **DONE** (later commit / current tree implements it), **OPEN** (defect
still present), **PARTIAL**, **SUPERSEDED** (a different design made it moot),
**UNKNOWN** (could not establish).

### 1. Define red-evidence production + hold rule — DONE

- `templates/spec-plan-adversarial.yaml:94-98` mandates the canary: a regression test must
  "FAILING with the fix disabled, then PASSING with it restored, raw output for both"; the
  DoD repeats it at `:162`. `templates/tdd-build.yaml:50` requires "a committed fixture and a
  failing test before the implementation".
- The deterministic mutant/canary replaces the multi-turn "fixer breaks the tree, waits for
  reviewer" dance that consumed r1-fixes, so a separate hold rule is no longer needed.

### 2. Reconcile test-first contracts with DoD; never promote a discarded peer's artifact — PARTIAL

- The "discarded peer's artifact → contract" path is structurally gone: the resume briefing
  (`src/runtime/run-state.ts:144,157`) says "no work order has been re-dispatched" and lists
  "in-flight edits (unverified) — inspect `git status`/`git diff`", and
  `src/runtime/runtime.ts:329` refuses legacy snapshots outright.
- Not institutionalized: no template/supervisor rule that "a work order may not name a symbol
  the DoD forbids" or that a resume order re-derives the contract from the DoD.
  (`src/pi/supervisor-prompt.md` has no such clause.)

### 3. Split compound DoD criteria into checkable lines — DONE

- `templates/spec-plan-adversarial.yaml:99-103` (R7) requires a criterion→check table before
  attestation ("absence → a grep that returns nothing; behaviour → a test invocation;
  unmodified → a git diff"), and the DoD pins it at `:163`.
- Caveat: the simpler templates (`code-fix.yaml`, `review-and-improve-code.yaml`) still carry
  compound DoDs; the mechanism exists but is not uniform.

### 4. Back-compat clause for behaviour-changing criteria — DONE (time-bounded)

- The #35 refusal is now explicit and named: `src/runtime/runtime.ts:326-332` throws
  "refusing to resume a legacy run-state snapshot without startedAtMs … start a new run
  instead" (commit `86d6f33`). The "new behaviour not requested" is now the documented,
  named-error behaviour the recommendation asked the criterion to state.
- No standing template rule "add a back-compat clause"; the concrete incident is resolved.

### 5. State the security bar precisely in the criterion — SUPERSEDED (moot)

- One-off ticket (#30). The shipped code is TOCTOU-safe and the ranges/behaviours the
  recommendation wanted stated are all present in `src/peer/web-tool.ts`: `safeLookup` dials
  exactly the validated address (`:117-137`), full v4/v6/CGNAT/NAT64/6to4 ranges (`:16-94`),
  `MAX_REDIRECTS = 5` (`:9`), 30 s timeout (`:243`), 50k body cap (`:13`), gzip/deflate/brotli
  (`:220-227`). No standing template carries this criterion, so there is nothing left to
  re-state.

### 6. Record base SHA in plan.md + checkable aggregate diff — OPEN

- No `base commit`/`base SHA` field and no aggregate-diff criterion in any template or in
  `src/` (grep across `templates/` and `src/` returns nothing; `spec-plan-adversarial.yaml:40-44`
  only allowlists `git diff --stat`). The empty-`git diff main...HEAD` failure mode is still
  possible.

### 7. Name the ownership-transfer escape hatch — DONE

- `src/pi/supervisor-prompt.md:51` — "When you reassign, update file ownership in plan.md so
  two peers cannot write the same file."
- `templates/spec-plan-adversarial.yaml:117-118` — "stop it and reassign its file to a live
  peer with the right permissions, transferring ownership in plan.md."

### 8. Resolve pricing or fall back to token budgets; enforce max_tokens — DONE

- `src/contracts/session-schema.ts:179-182` rejects an unpriced model with no `max_tokens`
  (unless `allow_unbounded: true`).
- `src/budget/budget-enforcer.ts:48-53` enforces the token bound (excluding cache-read tokens,
  RT-1); the stop lands via threshold% + `stop_at_work_order_boundary` (MT-3).
- `templates/free-research.yaml:20-21,54` document `agent_stop_threshold_percent: 100` +
  boundary stop, and label `$0` as "unknown, not a measured $0".
- The literal "hard stop at the turn boundary" is superseded by the threshold + boundary-stop
  mechanism, which closes the original "blew through by 33–44%" defect.

### 9. Reconcile DoD criteria against agent permissions — DONE

- Every read-only reviewer is now reconciled in the templates: "A read-only reviewer cannot
  write a file, so the supervisor transcribes it verbatim to run-details/ponytail-review.md"
  (`templates/tdd-build.yaml:93-94`, `templates/spec-plan-adversarial.yaml:138-139`, and the
  same in `free-research.yaml:68`, `pm-led-dev.yaml:88`, `security-review.yaml:25`).
- `src/contracts/session-schema.ts:139-143` refuses a `shell:true, edit:false` peer without a
  non-empty `shell_allowlist`/`shell_vocabulary` (the read-only toolset gap, RT-8 D1/F3).
- Commit `93f3ad2` recorded the F3 fix.

### 10. Carry artifact numbers verbatim + finalize mechanical check — PARTIAL

- Verbatim criterion matching is enforced: `src/supervisor/finalization.ts:87-104`
  (`normalizeCriterion`) + `criteriaMismatches`, commits `4d96818`/`cfd5924` (#118).
- The 30-vs-38 drift class is caught indirectly by the stale-citation gate
  (`src/supervisor/finalization.ts:135-170`, commit `a9cd25a`), which keys on mtime freshness,
  not on integer correspondence.
- The specific "every integer in the criteria block appears in the cited artifact" mechanical
  check is **not** implemented.

### 11. Ownership conflict + wait-for-work-order gate + edit-only — PARTIAL

- Wait-for-work-order gates exist: `templates/spec-plan-adversarial.yaml:233` ("Wait for the
  frozen contract and the aligned specs"), `templates/tdd-build.yaml:183` ("Wait for an
  explicit verification work order AND for the implementer to have reported a code change").
- Single-owner prompts ("Do not write other files", `spec-plan-adversarial.yaml:186,204,222`)
  remove the `docs/TODO.md` conflict.
- Not done: no explicit "edit tool only, NEVER use write" rule in writer prompts, and no
  harness-level "do not start write-enabled peers before their first work order" — `spawnPeers`
  (`src/runtime/runtime.ts:340`) launches all peers at start; the gate is prompt-only.

### 12. Stop forwarding whole peer reports to the supervisor — OPEN

- `src/supervisor/report-collector.ts:6-11` still emits `## <agentId>\n<full report>` verbatim,
  and `src/pi/extension.ts:493` hands that to `collect_reports`. No artifact-path + ≤2k
  summary, no `supervisor_tokens_per_dispatch` metric.

### 13. Fix the lock protocol — PARTIAL

- Within-peer batch serialization is done: `src/peer/file-lock.ts:26-29,41` queues a batch's
  second mutating call behind the first (the 35 s second-write failure is gone).
- Not done: the runtime still grants one lock per agent
  (`src/locks/file-lock-manager.ts:18-20`), `lock_acquire_timeout_ms` is hardcoded to 30 s
  (`src/runtime/runtime.ts:1396`), an unacquirable lock still waits FIFO rather than returning
  "busy" immediately, and `LOCK_REQUEST`/`LOCK_ACQUIRED`/`LOCK_RELEASED` still go to
  `conversation.jsonl`. Recent runs still show the noise: `05-interpretation/run-details/
  conversation.jsonl` is 40 of 53 lines `LOCK_*`.

### 14. Non-retryable billing/auth + smoke-test roster slugs — PARTIAL

- Classification done: `src/peer/peer-harness.ts:41-44` (`isTerminalProviderError`: 4xx other
  than 408/409/429 is terminal, wired into both retry decision points), commit `e00e043`.
- Smoke-test not done: `e00e043`'s message states "No roster pre-flight … stays deferred on
  evidence". What exists is `verify_models: strict` (`src/pi/model-preflight.ts`), which is
  catalog-resolution + auth-config, not a 1-token probe.
- Persist in-flight artifacts: only the dirty-tree guard `b1577dd` (#98) and the resume
  briefing note (`run-state.ts:157`); "mark a replaced peer's artifacts untrusted" is not
  implemented.

### 15. Judge "stalled" on tool-call age + per-model-class stall timeouts — PARTIAL

- Tool-activity progress done: `src/peer/peer-session.ts:37-53` treats
  `tool_execution_start/update/end` as progress and explicitly excludes
  `auto_retry_start/end` (commit `71c7ba4`), so a wedged retrying peer can now be flagged.
- Not done: `stall_timeout_ms` is a single session field (`src/contracts/session-schema.ts`),
  no per-model-class value (free slug 120 s), and no 30 s first-tool-call probe before a
  writer role.

### 16. Correlate await_response to work-order ids + discard stale frames — DONE

- `src/runtime/peer-messaging.ts:64` clears the buffered `await:<agent>` reply when a new
  request is sent, and `src/runtime/runtime.ts:508` clears it on dispatch, so a previous
  turn's report can no longer be returned verbatim (commit `0812e30`). The defect is fixed via
  clear-on-new-request rather than a literal work-order-id correlation.

### 17. Restrict write scope per work order + edit nearest-match diff — OPEN

- Write scope is agent-level `edit: true` only; no per-work-order file surface anywhere in
  `src/`. `src/peer/permission-gate.ts:10-18` gates only the `bash` shell allowlist, not
  writes. The `edit` tool is pi's built-in, so no nearest-match diff exists in this repo.

### 18. Standardize test runner + gate full suite behind one agent — PARTIAL

- The `shell_vocabulary` / `shell_allowlist` mechanism exists
  (`src/contracts/session-schema.ts:80`, `templates/spec-plan-adversarial.yaml:40-44`), and
  read-only verifiers are default-deny.
- Not done: no "forbid `npx`" rule, and no suite-serialization gate (nothing prevents three
  concurrent full-suite runs).

### 19. fallow-style gates get an explicit exit-status contract — SUPERSEDED

- The gate was redesigned to regression-relative rather than exit-code-keyed:
  `templates/tdd-build.yaml:100-103` — "gated on REGRESSION, never an absolute number … A task
  config must not hardcode a finding count or health score" (commit `4ce71e5`). The
  "fallow exits non-zero on findings counted as tool errors" defect no longer has a gate to
  poison.

### 20. Write final usage (supervisor included) into run-state.json at finalize — OPEN

- `writeRunStateSnapshot` is called only at dispatch (`src/runtime/runtime.ts:510`) and at
  `FINAL_REPORT` (`:1308`), never in `runFinalize` (`:594-712`).
- `src/budget/usage-accounting.ts:72-76` `getSessionTokens` sums agent tokens only; supervisor
  usage goes into `final.md`'s `costBreakdown` (`runtime.ts:769-791`) but never into
  `run-state.json`. The undercount the recommendation targets persists.

## 3. Time-bounded vs durable

**Time-bounded** (specific roster/model choices or one-off tickets of those three runs; no
longer reproducible because the templates/rosters changed):
- deepseek balance death (04 `402`) and r1-fixes "insufficient credits" — no current template
  rosters deepseek with a prepaid-balance assumption; the general class is now handled by
  rec 14's `isTerminalProviderError`.
- openrouter `:free` slug hangs (jev-c2-closeout `spec_writer`) — `spec-plan-adversarial.yaml`
  now uses priced slugs (`glm-5p3`, `deepseek-v4-pro`, `gemini-3.7-flash`, `gpt-6-luna`); the
  free-tier case is quarantined in `free-research.yaml` with explicit `max_tokens`.
- `commandcode/zai-org/GLM-5.3` latency (r1-fixes fixer-b) — that slug is not in any current
  template.
- Rec 5 (#30 web_fetch) and rec 4 (#35 rehydrate) are one-off tickets whose code shipped.

**Durable** (template / DoD / work-order / harness discipline that persists):
- recs 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20. Of these, 11 remain only
  partially or not at all addressed (2, 6, 10, 11, 12, 13, 14, 15, 17, 18, 20).

Sampling of later runs for the durable defects: `05-interpretation` (post-dates the three
targets) still shows the lock-noise defect — 40 of 53 `conversation.jsonl` lines are `LOCK_*`
(rec 13 open). `post-mortem-02` (read-only roster) shows 1 of 23 `LOCK_` lines, consistent
with lock volume tracking write activity rather than the defect being fixed.

## 4. Bottom line

The post-mortem's highest-cost findings are stale: the r1-fixes red-evidence dance (rec 1),
the read-only-reviewer contradiction (rec 9), the discarded-peer contract promotion (rec 2,
structurally), the unpriced-model accounting gap (rec 8), the stale `await_response` reply
(rec 16), and the balance-death retry loop (rec 14's classification half) are all fixed in the
current tree by later commits and by the rewritten `tdd-build`/`spec-plan-adversarial`
templates. What remains genuinely open is a cluster of lower-cost, mostly harness-level
discipline items: base-SHA/aggregate-diff (6), whole-report forwarding to the supervisor (12),
per-work-order write scope (17), and final-usage-to-run-state.json (20). The lock-protocol (13),
stall-timeout (15), roster-probe (14) and permission-gate (17/18) recommendations are only
partially landed.

**Verdict:** roughly half of the post-mortem is fully acted on (7 done + 2 superseded =
9 of 20), with 7 more partially landed; the four fully-open items are the cheapest of the set
and none is a money-burn at the scale the post-mortem originally measured.

**Counts:** ALREADY DONE **7** · STILL OPEN **4** · PARTIAL **7** · SUPERSEDED **2** · UNKNOWN **0**.

File: `docs/post-mortem-relevance-audit.md`.
