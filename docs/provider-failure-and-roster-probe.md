# Provider failure accounting and roster reachability probing

Scope. Written 2026-10-28 against `afshinator/mypy-multi-agent` HEAD `128cf152fa392cae603c7cd8a32b23a0abfd86ad`. Two questions, both against code and the run log:
1. Why did a terminal provider error (HTTP 412, account suspended) cost 4 model calls and 2 restart rounds, and what is the smallest change that (a) stops the retry and (b) shows the operator the provider's own message?
2. Why did `verify_models: strict` let an authed-but-dead slug spawn, and what is the smallest change that catches an unreachable-but-authed model before spending?

Files read and re-checked directly: `src/peer/peer-harness.ts`, `src/peer/peer-session.ts`, `src/peer/peer-main.ts`, `src/peer/peer-config.ts`, `src/runtime/runtime.ts`, `src/pi/extension.ts`, `src/pi/model-preflight.ts`, `src/contracts/session-schema.ts`, `src/contracts/a2a-schema.ts`, `src/scorecard/scorecard.ts`, `src/jev/injection-gate.ts`, `src/runtime/peer-terminal-error.ts`; dependency sources under `node_modules/@earendil-works/pi-coding-agent/dist/` and `node_modules/@earendil-works/pi-ai/dist/`; `test/unit/peer-harness.test.ts`, `test/unit/model-preflight.test.ts`, `test/integration/runtime.test.ts`, `test/contracts/session-schema.test.ts`, `test/integration/guardrails.test.ts`; `templates/*.yaml`; `mypi-tasks/*/session.yaml`. The failing run is `mypi-tasks/post-mortem-01/` (untracked run dir; `run-details/` is gitignored by `.gitignore:7`), read from the main checkout.

## F1 findings — the retry loop that owns `peer-retry`

**Two independent retry loops, and the bus log names the wrong one for this failure.**
- SDK loop (pi agent-level). `auto_retry_start` is emitted by `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:3036-3038` with `maxAttempts: settings.maxRetries`. The peer subscribes and folds the event into state: `src/peer/peer-session.ts:158-160` (`this.retry = { attempt: e.attempt, maxAttempts: e.maxAttempts }`), cleared on `auto_retry_end` or `finally`. It is exported on the heartbeat via `progressSnapshot()` (`src/peer/peer-session.ts:105-108`) → `src/peer/peer-main.ts:130,144` (`payload: { …, ...(retry ? { retry } : {}) }`).
- Harness loop (repo-owned). `handleWorkOrder` retries `retry.maxRetries` times (`src/peer/peer-harness.ts:85`), and the PROMPT path retries in `runPromptWithRetry` (`src/peer/peer-harness.ts:237`). `retry` is built from `peer_max_retries` / `peer_retry_pause_ms` (`src/runtime/runtime.ts:427-428`; defaults `3` and `30000` at `src/contracts/session-schema.ts:62-63`) → `src/peer/peer-config.ts:67-68` → `src/peer/peer-main.ts:238`.
- `peer-retry` is the _SDK_ loop. It is a log line, not a retry: `src/runtime/runtime.ts:918-930` logs on change only (`retryKey`, `:918`) with `event: "peer-retry"` (`:926`). The SDK loop runs inside the peer; the runtime/supervisor never retries a model call. The harness loop emits no `peer-retry` — its only trace is `AGENT_UNUSABLE.attempts`.

**The provider status reaches `SessionResult`, then dies at every decision point.**
- SDK composes the message: `formatProviderError` writes `"<status>: <body>"` (`node_modules/@earendil-works/pi-ai/dist/utils/error-body.js:111-118`). `absorbMessageEnd` folds `stopReason`/`errorMessage` into the turn accumulator (`src/peer/peer-session.ts:82-85`); the turn returns them in `SessionResult` (`src/peer/peer-harness.ts:17-24`; return at `src/peer/peer-session.ts:172-176`).
- `needsRetry` reads only `report` and `stopReason`, never `errorMessage`: `src/peer/peer-harness.ts:41-42` — `!result.report.trim() || result.stopReason === "error"`.
- `runPromptWithRetry` reads only `report.trim()`: `src/peer/peer-harness.ts:237`.
- `isUnusable` reads only `report` and `usage`: `src/peer/peer-harness.ts:49-52`.
- The operator-facing `reason` is a hardcoded literal `"empty model output"`: `src/peer/peer-harness.ts:73`, even though `errorMessage` is computed one line earlier (`:64-66`) and shipped as the optional `error` field.
- `Runtime.handleUnusable` destructures only `{ agentId, reason }` and drops `error`: `src/runtime/runtime.ts:1313-1314`; `controlPlane.stopAgent(agentId, reason)` at `:1321`.

So the 412 survives only in `AGENT_UNUSABLE.payload.error` (optional, `src/contracts/a2a-schema.ts:95-100`). `STOP_AGENT.reason` (`src/runtime/runtime.ts:1321`), the scorecard bucket (literal in `STOP_AGENT_REASON_CODES`, `src/scorecard/scorecard.ts:81-89`, else `"other"` at `:90-91`) and the `await_response` text (`src/pi/extension.ts:796-799`) all show `"empty model output"`.

**Error classification that exists today.** There is none in `src/`. `rg 'isRetryable|retryab' src/` matches one comment (`src/runtime/runtime.ts:689`); `PeerTerminalError` (`src/runtime/peer-terminal-error.ts:1-11`) classifies peer lifecycle, not provider HTTP. The only real classifier is the dependency: non-retryable patterns `node_modules/@earendil-works/pi-ai/dist/utils/retry.js:4-21` (`insufficient_quota`, `out of budget`, `quota exceeded`, `billing`, `Monthly usage limit reached`, `available balance`, Go/free-tier limits) and retryable patterns `:23-77` (`429`,`500`,`502`,`503`,`504`,`520`,`524`,`rate.?limit`, timeouts). `isRetryableAssistantError` returns false when neither matches (`:186-193`). The 412 text ("Account … is suspended, possibly due to reaching the monthly spending limit or failure to pay past invoices") matches neither branch — verified by evaluating the pattern against the logged string (result: `false`). The SDK correctly declined to retry; the harness did not.

**Cost from the run log** (`mypi-tasks/post-mortem-01/run-details/conversation.jsonl`, untracked):

```text
13 WORK_ORDER       1793245059302   (reviewer, glm-5p3)
14 AGENT_UNUSABLE   1793245150029   attempts:4, error:"412: {...suspended...}"
15 STOP_AGENT       1793245150032   reason:"empty model output"
16 restart-agent     1793245170807
18 WORK_ORDER       1793245202861
19 AGENT_UNUSABLE   1793245293480   attempts:4, error:"412: {...suspended...}"
20 STOP_AGENT       1793245293481   reason:"empty model output"
21 restart-agent     1793245324301
```

Two `AGENT_UNUSABLE` frames at `attempts: 4` (= `peer_max_retries` 3 + 1), 8 model calls and 2 restart rounds. Round-1 gap = 90,727 ms, round-2 gap = 90,619 ms, matching 3 × 30 s `peer_retry_pause_ms`. The reviewer's account was suspended; `session.yaml:261` still rostered `fireworks/accounts/fireworks/models/glm-5p3` and the run had no `verify_models` key, so it ran under the default `warn` (`src/contracts/session-schema.ts:69`).

## F2 findings — the pre-spawn check

**The check and its exact semantics.** `loadSession` at `src/pi/extension.ts:210-212` calls the pure, synchronous `findUnusableModels` (`src/pi/model-preflight.ts:24`). That resolves each distinct slug and checks `hasConfiguredAuth` (`src/pi/model-preflight.ts:39-47`); it does no I/O. `verify_models` is `z.enum(["strict","warn","off"]).default("warn")` (`src/contracts/session-schema.ts:69`). In `strict`, a failure triggers `ctx.ui.notify(..., "error")` and `return undefined` (`src/pi/extension.ts:214-217`), which aborts the command (`:408-409`); `warn` notifies `"warning"` and continues (`:218`); `off` skips the block entirely (`:210`). So `strict` means "resolves + has configured auth", never "answers". `docs/agent-config-guide.md:287` states this directly.

**Who sets it.** Active `strict`: 6 templates (`tdd-build.yaml:33`, `spec-plan-adversarial.yaml:35`, `pm-led-dev.yaml:38`, `free-research.yaml:35`, `review-and-improve-code.yaml:15`, `post-mortem.yaml:22`), 28 of 29 `mypi-tasks/*/session.yaml` (the 29th is `10-smoke-shell-gate/session.yaml:18`, `warn`), plus `docs/antislop/session-proposed.yaml:11`. Active `warn`: 1. Active `off`: 0. Every `mypi-tasks/*/session.yaml` sets the field. Redefining `strict` to "answers" therefore adds a real network call to 34 configs and can newly refuse to launch them. `test/integration/guardrails.test.ts:74` also couples on `verify_models !== "strict"`.

**In-process single completion exists.** `ModelRegistry` is on `ExtensionContext` (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:225`). Signature: `complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>` (`.../core/model-registry.d.ts:40`). `Context = { systemPrompt?, messages: Message[], tools? }` and `UserMessage` requires a `timestamp` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:365-373, 532-538`). `complete` is `stream(...).result()` (`.../core/model-runtime.js:486-488`), and `stream` asserts a chat model via `assertChatModel(model)` (`:478-481`). Setup failures do not reject — `lazyStream` converts them to an `AssistantMessage` with `stopReason: "error"` (`node_modules/@earendil-works/pi-ai/dist/api/lazy.js:17,36-43`), so a probe must inspect `stopReason`/`errorMessage`, not use try/catch. `classify` is the wrong primitive: it needs `getModelOfType("classifier", …)` (`src/pi/extension.ts:659`), while peers are chat models. No `src/` code calls `complete` today; only `classify` (`src/pi/extension.ts:678,719`).

**Cost and latency.** Documented figures are for the classifier, not a chat completion: ~$1.55e-5/call at 393 tokens and 170-870 ms (`docs/jev/implementation-plan.md:63-69`, `:151`). No measured figure exists in-repo for a tiny chat completion. `findUnusableModels` already de-dupes by slug (`src/pi/model-preflight.ts:29-31`), so a probe would make one call per distinct slug.

**Timeout mechanics.** The only bounded model call in `src/` is `bound` in `src/jev/injection-gate.ts:152-160` — module-private, used only for `screenInboundFrame` with `injection_timeout_ms` (default 2000, `src/contracts/session-schema.ts:50`). Its error text is `"classify failed: timeout after N ms"`. The SDK exposes `signal?: AbortSignal` and `timeoutMs?: number` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:60,98`), but the doc comment warns it applies only "for providers/SDKs that support it … OpenAI and Anthropic SDK clients default to 10 minutes" (`:95-98`), so an outer race is still required. Today's `classify` call sites pass neither (`src/pi/extension.ts:678,719`). Nothing would prevent a hung probe from wedging `loadSession` before `startRun`.

**Tests.** `test/unit/model-preflight.test.ts` covers `findUnusableModels` with a fake registry (no I/O) and `duplicateModelSlugs`. `test/contracts/session-schema.test.ts:205-217` covers the `verify_models` enum/default. `test/integration/guardrails.test.ts:74` couples the placeholder exemption to `strict`. Nothing tests reachability; the only live model test is `test/integration/jev-live.test.ts` (gated `JEV_LIVE=1`).

## Smallest change for each

**F1 (a) stop the retry — `needsRetry`, `src/peer/peer-harness.ts:41-42`, referenced by the PROMPT loop at `:237`.** Add one shared predicate on `errorMessage`: treat a leading 4xx (except 408/409/429) as terminal, and have both loops exit on it. Both sites must change — the empty-report clause alone still fires on a 412, so guarding `needsRetry` only is insufficient.

**F1 (b) show the operator the message — `unusableEnvelope`, `src/peer/peer-harness.ts:73`.** Use the already-computed `error` (fallback `"empty model output"`) as `reason` instead of the literal. That single line propagates to `STOP_AGENT.reason` (`src/runtime/runtime.ts:1321`) and the `await_response` text (`src/pi/extension.ts:798`). It also changes what the scorecard buckets: any non-listed string becomes `"other"` (`src/scorecard/scorecard.ts:90-91`), and tests assert the literal (`test/unit/peer-harness.test.ts:187`, `test/integration/runtime.test.ts:902`).

**F2 probe the slug — new sibling function in `src/pi/model-preflight.ts`, called from `loadSession` at `src/pi/extension.ts:210-211`.** One async function that resolves each distinct slug, skips non-chat types, calls `ModelRegistry.complete` once per slug with `{ timeoutMs, maxRetries: 0 }` plus an outer race (export and reuse `bound` from `src/jev/injection-gate.ts:152`, or use `AbortSignal.timeout` as in `src/peer/web-tool.ts:253`), and treats anything other than `stopReason === "stop"` as unreachable. Merge the failures into the `unusable` list. Do **not** add I/O to `findUnusableModels` (`src/pi/model-preflight.ts:24`): it is synchronous, pure and fake-registry tested, and is also called synchronously from the `restart_agent` model swap (`src/pi/extension.ts:628`).

**What neither change fixes.** (F1) Neither fixes the SDK's own budget accounting or the provider's suspended account; the run still fails, just in 1 attempt with a real message, and the supervisor still has no automatic reassign-on-412. (F2) A probe proves one slug answered once; it does not track a mid-run suspension, and it costs a real call per distinct slug at every `strict` launch. `complete` returns an error `AssistantMessage` rather than rejecting, so a probe keyed on exceptions would silently pass.

**What would be over-engineering here.** For F1: no new config field for per-status retry policy — the evidence is one 412 and the dependency already ships the classification patterns (`retry.js:4-77`). No new `SessionResult` status field, no status→terminal table in `src/`, no surgical edit to `scorecard.ts`'s reason set. For F2: no new schema field or `verify_models` mode, no per-agent retry ladder, no probe cache, and no change to `findUnusableModels`' signature. The probe is justified by 34 `strict` configs and one suspended account; anything beyond one call per distinct slug is not.

## Implemented — 2026-10-28, `e00e043`

F1 landed. `isTerminalProviderError` (`src/peer/peer-harness.ts`), wired into `needsRetry`
and the `runPromptWithRetry` loop; the unusable reply (`src/pi/extension.ts`) now appends the
payload's `error`.

**One deviation from the recommendation above.** F1(b) was _not_ implemented by changing the
`reason` literal. That literal is a scorecard bucket key (`STOP_AGENT_REASON_CODES`,
`src/scorecard/scorecard.ts:81-88`), so replacing it files every such stop under `"other"`
and corrupts the mistake-class histogram the scorecard exists to produce. The operator gets
the provider's own message from the `await_response` reply instead, and
`AGENT_UNUSABLE.payload.error` already carried it. `STOP_AGENT.reason` deliberately still
reads `"empty model output"`.

F2 was **not** built. Measured here: `verify_models: strict` is set in **34 configs under
version control** (6 templates, 28 task configs — 35 on disk counting the untracked scratch
config this session created, and one more in `docs/antislop/session-proposed.yaml`), and
`docs/agent-config-guide.md:287` documents `strict` as resolution + auth, so redefining it
changes launch behaviour for all of them; the always-on alternative adds a network call and a
timeout race to every run, and nothing in `src/` bounds a model call today. F1 removes most of
the cost F2 was meant to avoid, so F2 stays deferred on that evidence rather than built
speculatively.

## Open questions

1. Does a 4xx `errorMessage` reliably carry a leading `"<status>: "` for every provider, or only where `formatProviderError` takes the no-prefix branch (`error-body.js:111-118`)? Settle by logging `errorMessage` shape across providers, or by propagating the SDK's `isRetryableAssistantError` result from `src/peer/peer-session.ts` instead of re-parsing text.
2. Does `settings.retry.maxRetries` (3, per the historical comment in `mypi-tasks/jev-c2-closeout/session.yaml:40-44`) ever combine with the harness retry to produce more than `peer_max_retries + 1` attempts when a provider error is genuinely retryable? Settle with a fault-injected 500 and counting attempts on both loops.
3. What is the real latency and cost of one tiny `complete` call on `deepseek/deepseek-flash` and `opencode/gpt-6-luna`? In-repo figures are classifier-only (`docs/jev/implementation-plan.md:63-69`). Settle by timing `test/integration/jev-live.test.ts`-style runs.
4. Should a failed probe block launch in every `strict` config, or only where the operator opts in? The presence of 34 `strict` configs makes this a behavioral change, not a bug fix. Settle by deciding whether `strict` is redefined or a new mode is added.

## Claims that did not survive re-check

- **f2's proposed probe insertion point is wrong.** f2 said to call the probe "inside `if (unusable.length > 0)` and immediately before the error notify" (`src/pi/extension.ts:214`). That branch is only reached when `findUnusableModels` already found a resolution/auth failure (`:212`); a slug that resolves and has auth — exactly the suspended-account case — yields `unusable.length === 0` and skips the whole block. The call belongs at `src/pi/extension.ts:210-211`, outside the `length > 0` test, merging probe failures into `unusable`.
- **The probe-recipe line range is approximate.** f1 and f2 both cited `docs/agent-config-guide.md:281-288`; the measured-probe bullet runs `:282-288` and the live-probe sentence is `:286-287`. Off by at most one line, no conclusion affected.
- **f1 cited `templates/post-mortem.yaml:390-392` for "Probe a slug live before rostering it"**; the text is at `templates/post-mortem.yaml:271`. Content correct, line wrong.
- **f1 cited `docs/evidence/retry-recovery-2026-10-17.md:9-10` for the `retryMaxRetries: 0` quote**; it is at line 15.
- **f1 cited `src/contracts/session-schema.ts:62` for `peer_max_retries`**; `:62` is `peer_retry_pause_ms`, `:63` is `peer_max_retries` (both defaults verified: 30000, 3).
- **f1 cited `src/scorecard/scorecard.ts:83-93`**; the set is `:81-88` and `normalizeStopReason` is `:90-91`. Behavior verified.
- Otherwise the load-bearing F1 claims (two loops; `peer-retry` fed from the SDK heartbeat; status present in `SessionResult` but unread by `needsRetry`/`runPromptWithRetry`/`isUnusable`; literal reason; `error` dropped in `handleUnusable`; no in-`src/` classifier; `attempts: 4` × 2 and 90.6-90.7 s rounds) all reproduced.
