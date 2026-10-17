# Code-health audit — 2026-10-17

One-shot whole-repo audit (ponytail-audit, level full). Nothing in this file was
changed in code; it records findings only. Findings are not yet filed in the
issue tracker (`afshinator/mypy-multi-agent`) — see §4.

Order of importance used: correct, safe, holds under load, tested, fast, lean.

## What the repo does, and the load assumed

A local multi-agent orchestrator for coding work. One interactive pi
**supervisor** reads `session.yaml`, spawns headless pi **peers** into herdr
terminal panes, coordinates them over a unix-socket A2A bus (JSONL frames with
correlation IDs and heartbeats), and writes `final.md` / `findings.md` in the
run's `run-details/`. TypeScript on bun, shipped as a pi extension
(`src/pi/extension.ts`).

- ~7,100 LOC source, ~11,000 LOC test. 77 test files, **661 tests pass**, 2 skipped
  (the live E2E suite, skipped without `HERDR_ENV=1`). `tsc --noEmit` clean.
- **Load assumed:** one developer, one machine, one supervisor run at a time,
  2–6 peers, runs of 10 minutes to a few hours, many processes writing into one
  `run-details/` directory. No multi-host, no multi-tenant, no untrusted remote input.

## Must fix

### 1. Tool-call log lands in `/tmp` when the run path is long

`src/bus/socket-server.ts:16-22`, `src/peer/peer-main.ts:62`

- **What this is:** the peer derives its output directory from `dirname(busPath)`.
  When the socket path is ≥100 chars, `resolveSocketPath` moves the socket to
  `$TMPDIR`, so `dirname` becomes `/tmp`.
- **Problem:** `just task spec-plan-adversarial` builds
  `/Users/…/ma-wt-spec-plan-adversarial/.mypi/spec-plan-adversarial/run-details/.a2a-agent-bus.sock`
  = 115 chars. The peer then appends to `/tmp/tool-calls.jsonl` — a file shared by
  every run on the machine. Consequences: `runtime.attesterReadTimes`
  (`src/runtime/runtime.ts:599`) reads `run-details/tool-calls.jsonl` and finds
  nothing, so the issue #8 "cited file was rewritten after the attester read it"
  check silently stops working; `src/scorecard/record.ts:101` reports zero tool
  calls. The main-checkout path for `.mypi/jev-capture-accept` is already 96 chars —
  4 short of the cliff.
- **Fix:** carry `runDetailsDir` in `PeerConfig` (`src/peer/peer-config.ts`,
  `Runtime.writePeerConfig`) and `join(cfg.runDetailsDir, "tool-calls.jsonl")`
  instead of `dirname(cfg.busPath)`. One field, no new logic.
- **If skipped:** which safety checks exist depends on how deep the checkout is,
  and no artifact says so.

### 2. One failed log write blocks `final.md` forever

`src/runtime/runtime.ts:648` (`flush`), used at `:525`

- **What this is:** `flush()` is `await Promise.all(this.pendingLogs); this.pendingLogs = []`.
- **Problem:** if any earlier `conversation.jsonl` append rejected (disk full, or
  `run-details/` removed mid-run — e.g. `just cleanup .mypi/x` from a second
  terminal), the rejected promise stays in the array. `Promise.all` rejects before
  the array is cleared, so `finalize` throws at `await this.flush()` *before*
  `FinalWriter.write`, and every retry of `/finalize` rejects on the same promise.
  The run can never produce `final.md`, and the first abort path is the only way out.
- **Fix:** `await Promise.allSettled(this.pendingLogs); this.pendingLogs = [];`.
  Logs are diagnostic; the terminal artifact is not.
- **If skipped:** a transient write error costs the whole run's result file.

### 3. Validation commands have no timeout, so finalize can hang forever

`src/runtime/runtime.ts:83` (`defaultExecValidation`)

- **What this is:** `execFile("sh", ["-c", command], cb)` with no `timeout`.
  `finalize` awaits each command, and peers are only stopped *after* `finalize`
  returns (`src/pi/extension.ts:finalizeRun`).
- **Problem:** `validation.commands: ["bun run dev"]`, or a test suite that waits
  on a port, leaves the run in FINALIZING indefinitely, with peers still spending
  budget and no artifacts written. `session.finalization_grace_ms` is validated and
  documented as "reserved — not consumed" (`docs/agent-config-guide.md:98`), so the
  operator has a knob that does nothing.
- **Fix:** pass `{ timeout: config.session.finalization_grace_ms }` in
  `defaultExecValidation` and treat a timeout as `failed`. Gives the reserved field
  the job it was meant to have.
- **If skipped:** the run never ends and nothing says why.

## Should fix

### 4. A non-attester's verdict resets the staleness clock

`src/runtime/runtime.ts:1134-1146` (`captureCriteria`)

- **What this is:** `this.criteriaAttestedAt = this.now()` runs *before* the
  `agentId !== attester` check, so any peer's fenced verdict block moves the
  "attested at" instant.
- **Problem:** the second reviewer replies with a verdict block at T3, after the
  attester attested at T1 and a fixer rewrote `src/x.ts` at T2. `staleCitations`
  compares against T3, so the rewrite looks older than the attestation. The issue #8
  read-time check normally catches this — but not when the attester inspected via
  `bash` (no `read` entry in the tool-call log) or when finding 1 moved that log.
- **Fix:** move the `criteriaAttestedAt` assignment below the attester check. Two
  lines; the existing "ignores and logs a non-attester" test
  (`test/integration/artifacts.test.ts:272`) still passes.
- **If skipped:** the one guard against certifying stale evidence can be switched
  off by an honest second opinion.

### 5. Abort skips teardown when a pane close fails

`src/control/abort.ts:24-26`, `src/runtime/runtime.ts:376`

- **What this is:** `abortSession` runs `terminateAll()`, then `bus.stop()`, then
  writes the aborted `final.md`, with no `try/finally`. `Runtime.stop()` uses
  `try/finally` for exactly this reason.
- **Problem:** herdr already quit (or the pane is gone), `closePane` rejects,
  `terminateAll` rethrows the first failure → `bus.stop()` and the `final.md` write
  are skipped, the socket file stays behind, and `session_shutdown`'s
  `.catch(() => {})` hides the error. The next run in that directory fails with
  "bus already running at …".
- **Fix:** wrap `terminateAll()` in `try/finally` covering `bus.stop()` and the writer.
- **If skipped:** abort — the path used when things are already wrong — makes it worse.

### 6. A failed status or log write kills the peer process

`src/peer/peer-main.ts:81`, `src/peer/tool-call-logger.ts:29`

- **What this is:** `void status.setStatus(...)` and `void log.append(entry)` start
  promises with no rejection handler. `void` is not a handler; bun exits 1 on an
  unhandled rejection (verified on bun 1.4.2).
- **Problem:** `herdr pane report-metadata` fails (pane gone, herdr restarting) → the
  peer dies mid-turn; the runtime sees a disconnect and marks it CRASHED. Tokens are
  paid for and the turn is lost.
- **Fix:** `.catch(() => {})` on both. Status is cosmetic; a tool-log line is diagnostic.
- **If skipped:** a display failure is indistinguishable from a peer crash.

### 7. Validation never runs for code changed through `bash`

`src/peer/change-notifier.ts:13`

- **What this is:** `MUTATING_TOOLS = new Set(["edit","write"])`; only those arm the
  `INTENT_TO_MODIFY` change signal that decides whether `validation.commands` run.
- **Problem:** a fixer applying `git apply`, `sed -i`, `patch`, or `rm` changes code,
  the gate stays unarmed, `runValidation` returns `skipped`, and `/finalize true`
  writes `exit_code: 0` with the test suite never run. Documented as a caveat in
  `docs/agent-config-guide.md` §8, so the trade is known — but it currently fails
  silently and successfully.
- **Fix:** add `"bash"` to `MUTATING_TOOLS`. Cost: a read-only peer's `git status`
  also arms the gate, so the suite runs once more at finalize. Correctness beats one
  wasted run.
- **If skipped:** "validated" means "validated when the peer happened to use the edit tool".

### 8. `web_fetch` will fetch any host, including loopback and link-local

`src/peer/web-tool.ts:26-36`

- **What this is:** only the URL scheme is checked. Host, port, and redirect targets
  are not.
- **Problem:** a peer steered by an injected report (the Jev injection gate is off by
  default) can fetch `http://127.0.0.1:9229/json`, `http://169.254.169.254/…`, or any
  intranet host, and can exfiltrate file contents it has read via a GET query string
  to an arbitrary domain. There is no per-peer host allowlist.
- **Fix:** resolve the host, reject loopback/private/link-local addresses, and
  re-check each redirect hop (`redirect: "manual"`). ~15 lines, no new dependency.
- **If skipped:** the only network egress in the system is also the only
  exfiltration channel, unguarded.

### 9. Five copies of "read JSONL, skip bad lines"

`src/scorecard/record.ts:69`, `src/scorecard/trends.ts:11`,
`src/scorecard/improvements.ts:148`, `src/runtime/runtime.ts:599`

- **What this is:** each caller re-implements read → split → trim → `JSON.parse` →
  skip-malformed, with slightly different casts.
- **Problem:** a fix to one (size cap, logging skipped lines, BOM) never reaches the
  others; `runtime.ts` and `record.ts` must agree on `tool-calls.jsonl` semantics and
  currently agree only by luck.
- **Fix:** one `readJsonl(path, validate)` next to `ConversationLog`, used by all four.
- **If skipped:** ~50 lines that must be read and changed together stay separate.

### 10. Classifier slug resolution duplicated

`src/pi/extension.ts:557-580` (`jevAdvisory`) and `:603-626` (`buildInjectionEstimate`)

- **What this is:** the same 17 lines in both: split on `/`, look up a `classifier`
  model, notify when missing.
- **Problem:** the two must stay identical (only the question differs). A change to
  the slug format lands in one and the other silently stops resolving.
- **Fix:** `resolveClassifier(ctx, slug): Model | undefined`; both call it.
- **If skipped:** the two seams drift apart silently.

### 11. One 140-line handler does eight jobs

`src/pi/extension.ts:176-315` (fallow: CRITICAL, 26 cyclomatic, 33 cognitive)

- **What this is:** the `/mypi-multi-agent` handler does path resolution, scaffolding,
  YAML parse, resume validation, model preflight, config advisories, runtime
  construction, peer spawn, and briefing, in one function.
- **Problem:** every change to any step requires reading all of it, and each step has
  its own `notify + return` error path that is easy to break while editing another.
- **Fix:** split by job: `loadSession(...) → {config, askDir, raw, resumeState}` and
  `startRun(...)`. Both stay in the extension; no new module.
- **If skipped:** the most-edited file stays the hardest to change safely.

### 12. `dispatch_work_order` reports success for work that went nowhere

`src/pi/extension.ts:358-375`, `src/runtime/runtime.ts:391`, `:863`

- **What this is:** `dispatch` returns whatever `controlPlane.dispatchWork` says (a
  session-phase check only), and `emit` drops the envelope when there is no socket
  for the recipient.
- **Problem:** `dispatch_work_order({agentId: "reviewr"})` (typo) answers
  "dispatched to reviewr (state: ?)" and the order vanishes; the supervisor then
  waits out a full `await_response` timeout. Same for a peer that died 2 s ago but
  has not hit the 3 s heartbeat timeout.
- **Fix:** in `Runtime.dispatch`, return false unless the id is in `config.agents`
  **and** `this.sockets.has(agentId)`; report why in the tool result.
- **If skipped:** a typo costs a two-minute stall and derails the supervisor's plan.

### 18. No peer ever asks for a file lock

`src/locks/file-lock-manager.ts`, `src/runtime/runtime.ts:1055-1065,1193-1215`

- **What this is:** the runtime handles inbound `LOCK_REQUEST` / `LOCK_RELEASED` and
  answers `LOCK_ACQUIRED`, and `FileLockManager` has FIFO waiters and deadlock
  prevention. No peer process emits either request — the peer harness registers
  only the permission gate, the tool-call logger, the change notifier, and
  `web_fetch`.
- **Problem:** two peers editing the same file both proceed; nothing serializes
  them. The crash path's `locks.releaseAll(agentId)` frees locks nobody holds. The
  README lists "permissions/locking" as implemented and tested, which is true of the
  runtime arm and false of a live run. Found on a second pass, after the first
  audit traced handlers but not emitters.
- **Fix:** pick one. Wire a lock tool into the peer harness (the intent), or delete
  `FileLockManager`, its tests, and the three `LOCK_*` event types. Shipping both
  halves is the expensive option.
- **If we skip it:** two agents will eventually write the same file in one run, and
  the artifact will not say so.

### 19. No peer can open a prompt

`src/runtime/peer-messaging.ts:41`, `src/pi/extension.ts:381`

- **What this is:** `PeerMessaging.sendPrompt` is only reachable from the
  supervisor's `send_prompt` tool. A peer's pi session has no tool that writes to the
  bus, so the peer-to-peer `PROMPT` arm can never start from a peer.
- **Problem:** `README.md` claimed peers "message each other directly (A2A)", which
  is how a reader would justify the star-plus-mesh design. The protocol supports it;
  the product does not. README corrected 2026-10-17.
- **Fix:** decide whether peers get a messaging tool. If not, the protocol arm is
  dead weight and should go with finding 18's cleanup.
- **If we skip it:** the docs and the protocol keep promising a topology the run
  cannot produce.

## Nice to have

### 13. Supervisor cost double-counts earlier runs

`src/pi/supervisor-usage.ts:10-27` — `ctx.sessionManager.getEntries()` covers the
whole pi session, so a second `/mypi-multi-agent` run in the same pi session reports
run 1's supervisor cost again in `final.md`. Sum only entries after the run started.

### 14. `pendingLogs` is never pruned until finalize

`src/runtime/runtime.ts:648` — one settled promise per logged frame for the whole
run. Harmless at today's sizes; grows with run length. Prune on append.

### 15. Reserved config that does nothing

`src/contracts/session-schema.ts:20-21,65,92,110-111` — `capabilities`, `limits`,
`bus.transport`, `bus.socket_path`, `finalization_grace_usd`. Documented as reserved
(`docs/agent-config-guide.md:550`), but each is a knob a user will set and expect to
work. Finding 3 gives `finalization_grace_ms` a job; the other five can go.

### 16. Unused exports

`src/jev/injection-gate.ts:126,133` — `deriveClassifierError` and
`evaluateScreenResult` are only used inside the module. Drop the `export` keyword.

### 17. Stale comment on `ChangeDetector`

`src/validation/change-detector.ts:1-5` — says peers "do not emit"
`INTENT_TO_MODIFY` and `hasChanged()` stays false "until that wiring lands".
`src/peer/change-notifier.ts` has emitted it since P1-1. A reader will believe the
gate is dead.

## Left out as too small (6)

README still says 454 tests (actual: 661). README gives two different `final.md`
locations (it is `run-details/final.md`). `PaneManager.spawnAll` leaves one blank
pane when peers < rows×cols−1. Unused `docs/architecture-diagram-alternatives/*.ts`
plus unlisted `@viz-js/viz` dependency. The peer's fixed 1 s heartbeat ignores
`bus.heartbeat_interval_ms`. Hardcoded E2E default model slug in
`test/e2e/e2e.test.ts`.

## Verdict

Healthy core — clear module boundaries, unusually honest comments, 661 passing
tests — but three separate ways to lose or never write the terminal artifact.
Fix **1, 2, 3** first.

`Lean: -2 exports, -5 config fields, ~-70 lines from the JSONL and classifier duplication.`

## Not checked

Live herdr / E2E path (skipped without `HERDR_ENV=1`), `scripts/fault-inject.ts`
proxy behaviour end to end, `docs/architecture-diagram-alternatives/`, the pi SDK
contract behind `agent_settled` / `SessionEntry`, and how the Jev classifier actually
scores — those seams were trusted.

## Resolved since this audit (2026-10-17)

- **17** — the `ChangeDetector` comment now states what the code does.
- README terminology: the peer-to-peer claim (finding 19) and the two different
  `final.md` locations are corrected; vocabulary now lives in `GLOSSARY.md`.

## Filed as

All findings were filed in the tracker on 2026-10-17. Priority is carried by the
`priority:high` / `priority:normal` / `priority:low` labels (GitHub has no native
priority field); triage role labels follow `docs/agents/triage-labels.md`.

| Finding | Issue | Priority |
| --- | --- | --- |
| 1 tool-call log to /tmp | #23 | high |
| 2 flush blocks final.md | #24 | high |
| 3 validation has no timeout | #25 | high |
| 4 non-attester resets staleness | #26 | normal |
| 5 abort skips teardown | #27 | normal |
| 6 unhandled rejection kills peer | #28 | normal |
| 7 bash mutations skip validation | #29 | normal |
| 8 web_fetch host check | #30 | normal |
| 9 five JSONL readers | #31 | low |
| 10 duplicated classifier lookup | #32 | low |
| 11 140-line command handler | #33 | low |
| 12 dispatch claims success | #34 | low |
| 13 supervisor cost double-count | #35 | low |
| 14 pendingLogs growth | #36 | low |
| 15 reserved config fields | #37 | low |
| 16 unused exports | #38 | low |
| 17 stale ChangeDetector comment | #39 (closed) | low |
| 18 no peer asks for a lock | #40 | high |
| 19 no peer can open a prompt | #41 | low |

## Suggested issue order

Recommended: file **1–3** as one issue each (they are independent, small, and each
has a concrete failing case), then 4–8 as a batch, then 18–19 (each is a
keep-or-delete decision, so they need your call, not a patch), then 9–12 as
cleanup. 13–17 can ride along with whichever file is touched next.
