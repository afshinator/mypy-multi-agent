# ingestion-spec.md — C2 injection gate: execution / pipeline specification

| Field                 | Value                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | `pipeline_spec_author` (sole writer of this file)                                                                                                                                |
| Contract consumed     | `DC-JEV-C2-GATE` v`1.1.0`, status `FROZEN` (`.mypi/spec-c2-gate/data-contracts.md` §0; amended 2026-10-13, `§Amendment 2026-10-13`)                                              |
| Task root             | `.mypi/spec-c2-gate/` · branch `spec-c2-gate` (unmerged)                                                                                                                         |
| Evidence classes (R1) | `[exec-here]` command run in this workspace, raw output pasted · `[citation]` `path:line` + quoted text · `[reasoned]` named assumption, only where the other two are impossible |

## §0 Non-authority and consumed surface

This document specifies _execution order and behavior only_. It is **not** authoritative
over `data-contracts.md`; the contract is authoritative. Every record, field, enum
member, config key, ordinal rule and output destination named below is consumed
**verbatim** from `data-contracts.md` and the contract's § is cited on first use.
No local schema variant, alias, delimiter, status or output path is introduced.
[exec-here] `git rev-parse --abbrev-ref HEAD` → `spec-c2-gate`; `git log --oneline -5` →
`e7c2ddd docs: trim the run order to what is actually left` / `478eb83 feat: surface the cause of a mute peer in AGENT_UNUSABLE` / `01093a0 docs: queue the run order; add repo-cleanup and unusable-cause tasks` / `2e9a0ed chore: error-free lint gate and a dead-code pass` / `e590046 feat(template): harden spec-plan-adversarial (RT-8 R1-R13)`.

Consumed names and their canonical location (traceability; no redefinition):

| Name (consumed verbatim)                                                                                                                                  | Contract §            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `InjectionScreenInput` + fields `frameId`, `correlationId`, `sender`, `recipient`, `frameTimestamp`, `eventType`, `screenedField`, `content`              | §3                    |
| `ScreenedEventType`, `ScreenedField`, `InjectionEstimate`                                                                                                 | §3                    |
| `InjectionScreenResult` + fields `frameId`, `correlationId`, `sender`, `screenedField`, `score`, `threshold`, `flagged`, `error`                          | §4                    |
| `InjectionGateDecision` + fields `gate`, `contractVersion`, `frameId`, `correlationId`, `sender`, `eventType`, `model`, `threshold`, `flagged`, `screens` | §5                    |
| Classifier-error fallback record (fixed fields, `score: null`, `flagged: true`)                                                                           | §6                    |
| Comparator `flagged = score === null \|\| score >= threshold`                                                                                             | §7                    |
| Ordering rules for `screens`, run-log entries, JSON key order                                                                                             | §8                    |
| `InjectionGateLogEntry` + `InjectionGateEvent`, `InjectionGateLogLevel`, fields `at`, `level`, `event`                                                    | §9                    |
| Nullability behaviours (`correlationId`, `score`, `error`)                                                                                                | §10                   |
| Config keys `session.jev.injection_check`, `session.jev.injection_threshold`, `session.jev.injection_timeout_ms`, `session.jev.model`                     | §2                    |
| Fallback `error` derivation rule and the timeout-named message                                                                                            | §6 (amendment A3, A4) |

[reasoned] Only these names are reproduced; the pipeline introduces no field of its
own. Where a runtime sink or transport is unnamed by the contract, that is an
integration concern (implementation-plan), not a field this document may invent.

---

## §1 Insertion point

### §1.1 Cited call graph (real, verified)

1. Frame source — [citation] `src/runtime/runtime.ts:639` — `for (const line of framer.push(chunk.toString())) {`. One raw JSONL `line` per iteration.
2. Structural classification — [citation] `src/bus/message-validator.ts:17-33` — `classifyFrame` does `JSON.parse`, then `A2AEnvelopeSchema.safeParse`, then `payloadSchemas[env.data.type].safeParse`, returning `{ kind: "valid", envelope }` (line 31), `{ kind: "f1", ... }` (lines 22-27) or `{ kind: "f2", envelope }` (line 29). The payload **content** (`report` / `text`) is validated for _type only_ and is never screened. [citation] `src/bus/message-validator.ts:6` — "F2 = valid envelope whose payload fails its event schema."
3. F1/F2 policy — [citation] `src/bus/router.ts:24-53` — `export function routeFrame(line: string, deps: RouteDeps): A2AEnvelope | undefined`. F1 → `deps.malformed(c.reason)`, `deps.log({ event: "f1", reason: c.reason })`, `return undefined` (lines 26-29). F2 → `deps.sink.fail(...)`, `deps.sendError({ ... type: "ERROR", payload: { code: "F2_INVALID_PAYLOAD", ... } })`, `return undefined` (lines 31-51). Valid → `return c.envelope` (line 53).
4. Dispatch call site — [citation] `src/runtime/runtime.ts:643` — `const env = routeFrame(line, {`; the return is captured as `env`. [citation] `src/runtime/runtime.ts:653-655` — `if (env !== undefined) { try { this.handleEnvelope(env, connId, socket); } catch (err) {` — a non-`undefined` `env` goes to `handleEnvelope`, which is where the supervisor context is fed. [citation] `src/runtime/runtime.ts:690` — `private handleEnvelope(env: A2AEnvelope, connId: string, socket: Socket): void {`.
5. Content reaches supervisor context — [citation] `src/runtime/runtime.ts:775` — `private handleFinalReport(env: A2AEnvelope): void {` and [citation] `src/runtime/runtime.ts:828` — `private handleResponse(env: A2AEnvelope): void {`. These are the two arms whose payload content is screened (§3 `ScreenedEventType`).

[exec-here] `grep -n "const env = routeFrame\|private handleEnvelope\|if (env !== undefined)\|handleFinalReport(env)\|handleResponse(env)\|routeFrame(" src/runtime/runtime.ts` → raw output:
```
643:        const env = routeFrame(line, {
653:        if (env !== undefined) {
655:            this.handleEnvelope(env, connId, socket);
690:  private handleEnvelope(env: A2AEnvelope, connId: string, socket: Socket): void {
726:        this.handleFinalReport(env);
729:        this.handleResponse(env);
775:  private handleFinalReport(env: A2AEnvelope): void {
828:  private handleResponse(env: A2AEnvelope): void {
```

### §1.2 Exact step the gate runs in

The gate runs at the boundary **`src/runtime/runtime.ts:653-655`** — after
`routeFrame` has returned a non-`undefined` `env` and **before**
`this.handleEnvelope(env, connId, socket)` is invoked. Concretely, in the
`if (env !== undefined)` block, the gate is executed first, its `InjectionGateDecision`
(§5) is produced and attached, and only then is `handleEnvelope` called with the
**unchanged** `env`. [reasoned] from the cited call graph: this is the last point at
which the valid envelope is still a local value and the first point before payload
content reaches `handleFinalReport` / `handleResponse` / supervisor context. Placement
here also means the gate cannot observe or influence `classifyFrame`/`routeFrame`,
which have already completed.

Concurrency mechanism (DD-1 opponent O1, blocking). The seam is asynchronous while
frame dispatch is synchronous: [citation] `src/runtime/runtime.ts:638-639` —
`socket.on("data", (chunk) => {` / `for (const line of framer.push(chunk.toString())) {`;
[citation] `data-contracts.md` §3 — `InjectionEstimate = (content: string) =>
Promise<number>`. The data callback therefore becomes **`async`** and per-connection
frame dispatch is **serialized through a per-connection promise chain**: frame N+1's
`handleEnvelope` is not invoked until frame N's gate promise has settled.
[reasoned] This preserves §8 determinism: serialized dispatch keeps intra-connection
frame order identical to arrival order, so `at` is monotonic within a connection and
the §8 tie-breaks (`frameId` UTF-16 ascending, then `ScreenedField` ordinal ascending)
are exercised only across connections, where they are total and order-independent.
Identical input plus a fixed seam therefore yields an identical record sequence.

Throw containment (DD-1 opponent O4, non-blocking). The gate call sits inside the
existing `try` block at [citation] `src/runtime/runtime.ts:654-663`, so a
contract-violating throw is contained by the existing `envelope-handler-threw`
logging and socket-destroy path instead of escaping the inbound loop.

### §1.3 Steps the gate must NOT run in

- **Not before parsing.** The gate must not run on the raw `line` and must not call
  `JSON.parse` itself. [citation] `src/bus/message-validator.ts:22-24` — parsing and
  envelope validation belong to `classifyFrame`; content is unreachable until a
  `valid` classification exists (F5, `data-contracts.md` §1).
- **Not inside `classifyFrame`.** [citation] `src/bus/message-validator.ts:17-33` —
  `classifyFrame` is a pure structural function returning `valid`/`f1`/`f2`; adding a
  content screen would change its return surface. `data-contracts.md` §3 states the
  gate runs "after `classifyFrame` returned `valid`" and "never re-validates structure".
- **Not on f1 or f2.** The gate is skipped entirely when the classification is `f1` or
  `f2`, i.e. whenever `env === undefined`. [citation] `src/runtime/runtime.ts:653` —
  `if (env !== undefined) {`. F2's disposition is already fixed by the router
  (correlated `ERROR`, `src/bus/router.ts:31-51`); the gate must not add a second,
  competing disposition.
- **Not inside `routeFrame`.** [citation] `src/bus/router.ts:24-53` — `routeFrame`
  owns F1/F2 policy; inserting a content screen there would make routing depend on a
  stochastic classifier.

---

## §2 Routing-contract preservation (load-bearing decision DD-1)

DD-1 is owned here. [citation] `.mypi/spec-c2-gate/run-details/plan.md:58-59` — the plan
lists DD-1 as the `pipeline_spec_author` decision: "Gate returns a decision record and
the frame is _annotated_, not routed differently: `routeFrame`'s valid/undefined return
contract is unchanged."

### §2.1 The contract that must not change

[citation] `src/bus/router.ts:24` — `export function routeFrame(line: string, deps: RouteDeps): A2AEnvelope | undefined`. The preservation claim, stated precisely:
- `undefined` **still means f1 or f2, and only f1 or f2.** [exec-here] `grep -n "return undefined\|return c.envelope\|c.kind\|return;" src/bus/router.ts` → raw output:

  ```
  26:  if (c.kind === "f1") {
  29:    return undefined;
  31:  if (c.kind === "f2") {
  51:    return undefined;
  53:  return c.envelope;
  ```

  The only two `return undefined` sites are inside the `f1` branch (line 29) and the `f2`
  branch (line 51); the valid path returns the envelope (line 53). No other `return
  undefined` exists and no bare `return;` exists (the pattern includes `return;` so an
  early exit on the valid path cannot hide; §Opposition disposition O3).
- A **valid** envelope is still returned. [citation] `src/bus/router.ts:53` — `return c.envelope;`.
- A **flagged** frame is still a returned envelope. Because the gate executes only
  inside the `if (env !== undefined)` block ([citation] `src/runtime/runtime.ts:653`),
  a flagged frame is by construction one that `routeFrame` already returned as an
  `A2AEnvelope`. The gate never becomes a producer of `undefined`.

### §2.2 How the annotation attaches

The gate emits exactly one `InjectionGateDecision` per screened frame
(`data-contracts.md` §5), which carries `frameId` and `correlationId` linkage to the
envelope (`data-contracts.md` §5 fields `frameId`, `correlationId`) and the
`flagged`/`screens` payload. The per-screen `InjectionGateLogEntry`
(`data-contracts.md` §9) is appended to the run log. The decision record is the
annotation "attached to the frame and delivered to the supervisor context"
([citation] `data-contracts.md` §5). Attachment is **additive**: it does not mutate
`env`, does not replace `env`, and does not change what `handleEnvelope` receives.
[reasoned] The gate is a separate module (`src/jev/injection-gate.ts`, per
`data-contracts.md` §1 F9 and `docs/jev/implementation-plan.md:104-107`) that receives
the envelope and returns a record; it has no reference to `routeFrame`'s return value
or its `deps`.

### §2.3 Proof the return value is unchanged for flagged frames

Argument (all steps cited or exec-here above):
1. `routeFrame` returns `c.envelope` for a valid frame ([citation] `router.ts:53`) and
   the value is bound to `env` ([citation] `runtime.ts:643`).
2. The gate runs only when `env !== undefined` ([citation] `runtime.ts:653`), i.e.
   strictly after `routeFrame` has already produced its return value; a return value
   cannot be retroactively altered by code that runs later.
3. The gate produces a **new** record (`InjectionGateDecision`, `data-contracts.md` §5);
   its output is not `routeFrame`'s output. `handleEnvelope` is then called with the
   same `env` ([citation] `runtime.ts:655`).
4. A flagged frame is not converted into an `ERROR`. The router's only `ERROR`
   emission is the F2 reply ([citation] `router.ts:41-51`, `code: "F2_INVALID_PAYLOAD"`);
   the gate emits no envelope and has no `sendError` handle. [reasoned] There is no code
   path by which a flagged frame reaches `deps.sendError`.

**Falsifiable claim:** for every incoming frame line, `routeFrame`'s return value is
byte-identical in the presence and absence of the gate; specifically no flagged frame
yields `undefined`, and no flagged frame yields an `ERROR` envelope generated by the
gate.

---

## §3 Determinism

### §3.1 Ordering bound to contract §8

All arrays are ordered by `data-contracts.md` §8; this pipeline adds no ordering of its own.
- `InjectionGateDecision.screens` — sorted by `ScreenedField` ordinal, ascending:
  `"report"` (0) before `"text"` (1) (`data-contracts.md` §8; ordinals fixed in §3).
  Cardinality is 1 today; the rule is normative for any future multi-field frame.
- Run-log `InjectionGateLogEntry` entries — sorted by `at` ascending, tie-break
  `frameId` ascending (UTF-16 code-unit order), further tie-break `ScreenedField`
  ordinal ascending (`data-contracts.md` §8).
- JSON serialization — object keys emitted in the interface declaration order given in
  `data-contracts.md` §3-§5 and §9 (insertion order), not alphabetically
  (`data-contracts.md` §8).

### §3.2 Disagreement tie-break

When two screens of the same frame disagree (one `flagged`, one not), the frame-level
`flagged` is the disjunction `screens.some(s => s.flagged)` — **flagged wins**
(`data-contracts.md` §5 `flagged` and §8). No averaging and no max-score rule;
[reasoned] from `data-contracts.md` §8: "averaging would let a high-risk field hide
behind a low-risk one", and the fail-closed precedent at `src/jev/verdict-advisory.ts`
treats an unknown estimate as flagged, not as a pass.

### §3.3 Identical input → identical output (scoped honestly)

Given a fixed config (`session.jev.injection_check`, `injection_threshold`, `model`) and
a fixed classifier result, the pipeline is deterministic: the same `env` maps to the
same `InjectionGateDecision`, the same ordered `screens`, and byte-identical JSON
serialization. [reasoned] The gate performs no clock reads, no randomness, and no
unordered iteration; `screenedField` is derived deterministically from `eventType`
(`data-contracts.md` §3), `flagged` from the §7 comparator, and `event`/`level` from
`error`/`flagged` (`data-contracts.md` §9).

Determinism does **not** extend to the classifier itself. [citation]
`docs/jev/implementation-plan.md:61-62` (E2) — "**Variance: not deterministic** —
identical input returned bool probabilities 0.57-0.60 (opencode) and 0.57-0.59
(OpenRouter), ~0.03 spread." The seam (`InjectionEstimate`, `data-contracts.md` §3)
may return a different `score` for identical `content`. The pipeline is deterministic
_conditional on the seam's output_; it never averages or retries to hide variance
(§4). [citation] `data-contracts.md` §7 — "a threshold set within the spread of
observed scores will flip run to run".

---

## §4 Failure and fallback paths

### §4.1 Classifier error taxonomy

The seam is `InjectionEstimate` (`data-contracts.md` §3):
`(content: string) => Promise<number>`. By the contract's resolution clause, **any**
of the following is a classifier error and MUST become the §6 fallback record:

| Failure                                                  | Detection                         | Result             |
| -------------------------------------------------------- | --------------------------------- | ------------------ |
| Unavailable / call rejects (HTTP, missing registry, 402) | promise rejection                 | §6 fallback record |
| Non-number output                                        | `typeof r !== "number"`           | §6 fallback record |
| `NaN` / `Infinity`                                       | `!Number.isFinite(r)`             | §6 fallback record |
| Out of range                                             | `r < 0 \|\| r > 1`                | §6 fallback record |
| Timeout (non-zero `injection_timeout_ms`)                | promise unsettled after the bound | §6 fallback record |

[citation] `data-contracts.md` §3 (v`1.1.0`) — "any rejection, any non-number, any
`NaN`/`Infinity`, any number outside `[0,1]`, or a promise unsettled after
`session.jev.injection_timeout_ms` milliseconds (§2; non-zero — `0` disables the
bound) is a **classifier error** and MUST be converted by the gate into the fallback
screen record (§6) — never thrown, never an implicit pass." The timeout race is owned
by the gate call site (`data-contracts.md` §3), not by any record.

### §4.2 The fallback record (DD-3, frozen)

The gate emits the exact §6 record and nothing else: `score: null`, `flagged: true`,
`threshold` echoed from config, `error` a non-empty message; `frameId`,
`correlationId`, `sender`, `screenedField` echoed from the `InjectionScreenInput`
(`data-contracts.md` §6). [citation] `data-contracts.md` §6 — "Never an implicit pass
(`flagged` is never `false` with a null `score`) and never a throw: a classifier
failure must not break inbound delivery." Precedent: [citation]
`src/jev/verdict-advisory.ts:31-32` — "A failed call is flagged (unknown, not a pass),
never thrown — the advisory must not break finalization."; [citation]
`src/jev/verdict-advisory.ts:44-51` — `catch { establishes = null; }` then
`flagged: establishes === null || establishes < threshold`.

The fallback `error` message names the failure class; on a timeout it names the
bound, e.g. `"classify failed: timeout after 2000 ms"`. The derivation is the single
rule stated in [citation] `data-contracts.md` §6 (amendment A4) —
`err instanceof Error && err.message !== "" ? err.message : String(err) !== "" ?
String(err) : "classifier error"` — consumed unchanged by §4 and §9, so an
`Error("")` or an empty `String(err)` can never yield an empty `error`.

### §4.3 No throw out of the inbound path

The gate must not propagate an exception to the inbound frame loop. [citation]
`data-contracts.md` §6 — "never a throw"; §10 — `InjectionScreenResult.score` null
means "Treat the frame as flagged; never as an implicit pass". [exec-here]
`grep -n "throw\|establishes = null\|flagged: establishes" src/jev/verdict-advisory.ts`
→ raw output:
```
31: * A failed call is flagged (unknown, not a pass), never thrown — the advisory must not break finalization.
46:      establishes = null;
```
The shipped Jev surface converts the failure and returns, never throws. [reasoned] The
gate mirrors this: the seam call is `try`-wrapped; on rejection the gate produces the
§6 record and continues. A gate exception would otherwise risk the run: [citation]
`src/runtime/runtime.ts:654-663` contains the try/catch that logs
`event: "envelope-handler-threw"` and destroys the socket — the gate must not trigger
that path.

### §4.4 Retry posture

The gate does **not** retry inline. One `InjectionScreenInput` → exactly one seam call
→ exactly one `InjectionScreenResult` (`data-contracts.md` §4 cardinality: "exactly 1
per `InjectionScreenInput`"). [citation] `data-contracts.md` §10 —
"never retry inside the same screen record". What the caller sees: the seam's first
failure becomes the §6 fallback record (`score: null`, `flagged: true`), a
`InjectionGateLogEntry` with `event: "injection_classifier_error"` and `level: "warn"`
(`data-contracts.md` §9), and the frame is still delivered to `handleEnvelope` as an
annotation, not a rejection. No exception, no hidden second attempt, no implicit pass.
[reasoned] Retrying would multiply latency and spend inside the inbound path for a
probabilistic classifier, against the smallest-solution posture of
`docs/jev/implementation-plan.md:104-107` (log-and-continue only).

**Timeout (now canonical).** The bound is `session.jev.injection_timeout_ms`
(`z.number().int().gte(0).default(2000)`; `0` disables) — [citation]
`data-contracts.md` §2, §3 (amendment A1-A3). A seam promise unsettled after the
bound (non-zero) **is** a classifier error yielding the §6 fallback record; the race
lives at the gate call site, never inside a record (`data-contracts.md` §3). The gate
still does not retry inline: the one-call-per-input cardinality holds (`data-contracts.md`
§4); the timeout is a race on that single call, not a second attempt.

---

## §5 Step order

Deterministic per-frame pipeline. Every step lists input, output, and failure mode.

| #   | Step                                                                        | Input                                                                                                                       | Output                                                                                                                      | Failure mode                                                                                                                              |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Frame extraction — [citation] `src/runtime/runtime.ts:639`                  | socket `chunk`                                                                                                              | one raw JSONL `line` (`string`)                                                                                             | none here; a destroyed socket is skipped at `runtime.ts:642`                                                                              |
| 2   | Structural classification — [citation] `src/bus/message-validator.ts:17-33` | `line`                                                                                                                      | `FrameClassification`: `valid` / `f1` / `f2`                                                                                | none thrown; `f1` = invalid JSON or envelope (lines 22-27), `f2` = payload schema fail (line 29)                                          |
| 3   | F1/F2 policy — [citation] `src/bus/router.ts:24-53`                         | `line` + `deps`                                                                                                             | `A2AEnvelope` or `undefined`                                                                                                | `f1` → `deps.malformed` + log, `return undefined`; `f2` → `deps.sink.fail` + correlated `ERROR` via `deps.sendError`, `return undefined`  |
| 4   | Validity split — [citation] `src/runtime/runtime.ts:653`                    | `routeFrame` return `env`                                                                                                   | branch: `env !== undefined` → step 5; else → next line (gate skipped)                                                       | none; `undefined` is the f1/f2 disposition already performed in step 3                                                                    |
| 5   | Gate — inbound content screening (`data-contracts.md` §3-§5)                | the valid `A2AEnvelope` `env`; config `session.jev.injection_check`, `injection_threshold`, `injection_timeout_ms`, `model` | `InjectionGateDecision` (§5); **inert** (emits nothing) when `injection_check` is `false` or `session.jev` absent (§2)      | classifier error (rejection, non-number, out-of-range, or unsettled after `injection_timeout_ms`) → §6 fallback record, never thrown (§4) |
| 6   | Annotation / log (`data-contracts.md` §9)                                   | `InjectionScreenResult`                                                                                                     | `InjectionGateLogEntry` appended to the run log, ordered per §8                                                             | none expected; logging must not throw [reasoned]                                                                                          |
| 7   | Delivery — [citation] `src/runtime/runtime.ts:655`                          | unchanged `env` + the `InjectionGateDecision`                                                                               | `handleEnvelope(env, connId, socket)` dispatch; content reaches `handleFinalReport` / `handleResponse` / supervisor context | existing try/catch at `runtime.ts:654-663` logs `envelope-handler-threw` and destroys the socket; unchanged by the gate                   |

Ordering constraints (all [reasoned] from the cited call graph): step 2 must precede
step 3 (`routeFrame` calls `classifyFrame`, `router.ts:23`); step 3 must precede step 4;
step 4 must precede step 5 (the gate needs a valid `env`); step 5 must precede step 6
(the log entry derives from the screen result); step 6 precedes step 7 or is concurrent
with it, but the annotation must exist before the content reaches supervisor context.
Steps 1-4 are the existing pipeline and are **not modified** by this gate.

---

## §6 Not-building (explicit exclusions)

- No frame blocking or rejection. [citation] `src/bus/router.ts:24-53` — the router owns drop/ERROR; the gate never returns `undefined` and never drops a valid frame.
- No routing rewrite. [citation] `src/bus/router.ts:24` — `routeFrame`'s signature and branches are unchanged; the gate is not called from it (§1.3).
- No supervisor-side re-screening. [citation] `docs/jev/implementation-plan.md:104-107` (I4) — the gate screens valid inbound frame content at the runtime inbound path; no second screen is added on the supervisor side.
- No exit-code effect. [citation] `src/jev/verdict-advisory.ts:3-4` — "NEVER changes the exit code — that stays with the deterministic checks in `Runtime.runSucceeded`". The injection gate is annotation-only and carries the same posture.
- No new delimiter or output path. The gate writes only the `InjectionGateLogEntry` (`data-contracts.md` §9) to the existing run log; no new file, stream, or format is introduced. [reasoned]
- No threshold constant and no second model key. `session.jev.injection_threshold` and `session.jev.model` are read, never hard-coded (`data-contracts.md` §2; `.mypi/spec-c2-gate/run-details/plan.md:59`).
- No inline retry, no local timeout value (the bound is the canonical `session.jev.injection_timeout_ms`), no averaging. (§4.4, §3.2.)

---

## §7 Missing / amendment requests

Contract gaps found by this pipeline: none open after v`1.1.0`. Q1 (classifier
timeout) was raised here before the amendment and is **resolved** by the
`§Amendment 2026-10-13` (A1-A3): `session.jev.injection_timeout_ms` is canonical
(`data-contracts.md` §2, §3). One integration detail remains explicitly out of
contract scope and must not be invented here:
- Q2 (to supervisor): the contract names the decision record as delivered to
  supervisor context (`data-contracts.md` §5) but does not name the runtime **sink** or
  transport that stores it. That is an integration detail for `implementation-plan.md`;
  this document does not define a sink field.

---

## §Anchors

§0 Non-authority and consumed surface · §1 Insertion point (§1.1 call graph, §1.2 the
step it runs in, §1.3 steps it must not run in) · §2 Routing-contract preservation
(DD-1) · §3 Determinism · §4 Failure and fallback paths · §5 Step order · §6
Not-building · §7 Missing / amendment requests · §Falsifiers · §Opposition disposition
(DD-1; O1-O4).

---

## §Falsifiers (pre-registered, before opponent review; owner: `pipeline_spec_author`, DD-1)

FALSIFIER: `routeFrame` can return `undefined` for a frame `classifyFrame` classified `valid`, so `undefined` does not mean only f1/f2 and a flagged delivery could be dropped | grep -n "return undefined\|return c.envelope\|c.kind\|return;" src/bus/router.ts

FALSIFIER: the gate is invoked before parsing or inside `classifyFrame`/`routeFrame`, or the valid/undefined split is not the `env !== undefined` branch at the dispatch call site, so the insertion point in §1.2 is wrong | grep -n "routeFrame\|classifyFrame\|env !== undefined\|handleEnvelope" src/runtime/runtime.ts

FALSIFIER: the DD-3 fail-closed precedent does not bind — `src/jev/verdict-advisory.ts` rethrows a classifier error or leaves `flagged` false on a failed estimate, so §4's never-throw / never-implicit-pass fallback rests on nothing | grep -n "throw\|establishes = null\|flagged: establishes" src/jev/verdict-advisory.ts

FALSIFIER: a canonical `injection` config key or timeout already exists in the session schema (contradicting §2 additions and §4.4), so this pipeline's config read is wrong | grep -n "injection" src/contracts/session-schema.ts

---

## §Opposition disposition (DD-1; opponent: `data_contract_author`)

Contract consumed: `DC-JEV-C2-GATE` v`1.1.0`. Round on DD-1 (§2). Four candidate
failure modes were surfaced and classified by the opponent; all four are dispositioned
**ACCEPT-and-revise** below — none is rebutted or rejected. Each carries its evidence
class (R1).

### O1 — async seam vs the synchronous `socket.on("data")` for-loop — blocking — ACCEPT-and-revise

Candidate: the gate's seam returns a promise while frame dispatch runs inside a
synchronous callback, so "gate before delivery" cannot hold by default.
- [citation] `src/runtime/runtime.ts:638-639` — `socket.on("data", (chunk) => {` /
  `for (const line of framer.push(chunk.toString())) {` — the callback and loop are synchronous.
- [citation] `data-contracts.md` §3 — `InjectionEstimate = (content: string) => Promise<number>` — the seam is asynchronous.

Fix applied (option i): the data callback becomes `async` and per-connection frame
dispatch is serialized through a per-connection promise chain, so frame N+1's
`handleEnvelope` is not invoked until frame N's gate promise has settled. Stated in
§1.2. Why it preserves §8 determinism: [reasoned] serialized dispatch keeps
intra-connection frame order identical to arrival order, so `at` is monotonic within a
connection and the §8 tie-breaks are exercised only across connections, where they are
total and order-independent; identical input plus a fixed seam yields an identical
record sequence.

### O2 — a never-settling seam — blocking — ACCEPT-and-revise

Candidate: a seam that neither resolves nor rejects produces no §6 record and stalls
delivery.
- [exec-here] `node -e 'const seam = () => new Promise(() => {}); (async () => { const outcome = await Promise.race([ seam("x").then(()=>"settled"), new Promise(r=>setTimeout(()=>r("still-pending-after-1000ms"),1000)) ]); console.log("outcome:", outcome); process.exit(0); })();'` → `outcome: still-pending-after-1000ms`.
- [citation] `data-contracts.md` §3 (v`1.1.0`) — "or a promise unsettled after `session.jev.injection_timeout_ms` milliseconds (§2; non-zero — `0` disables the bound) is a **classifier error** and MUST be converted by the gate into the fallback screen record (§6)".
- [citation] `data-contracts.md` §6 (v`1.1.0`) — the fallback `error` "names the bound, e.g. `\"classify failed: timeout after 2000 ms\"`".

Fix applied: §4.1 and §4.4 now read that a promise unsettled after the bound **is** a
classifier error yielding the §6 fallback record. The pre-amendment line "the gate treats a
timeout only as a seam rejection" was unsound and is replaced in §4.4 and §7. The
bound is the canonical `session.jev.injection_timeout_ms` (`z.number().int().gte(0).default(2000)`;
`0` disables); no local timeout value or key is introduced.

### O3 — falsifier pattern cannot see a bare `return;` — non-blocking — ACCEPT-and-revise

Candidate: the DD-1 falsifier grep would miss a bare `return;` early exit on the valid
path, so the "undefined means only f1/f2" proof could be fooled.
- [exec-here] `grep -n "return undefined\|return c.envelope\|c.kind\|return;" src/bus/router.ts` → raw output:

  ```
  26:  if (c.kind === "f1") {
  29:    return undefined;
  31:  if (c.kind === "f2") {
  51:    return undefined;
  53:  return c.envelope;
  ```

  No bare `return;` exists in `src/bus/router.ts` today; the extended pattern means one cannot hide in future.

Fix applied: §2.1's proof and the DD-1 `FALSIFIER` line in §Falsifiers now use the
extended pattern `return undefined\|return c.envelope\|c.kind\|return;`. The
`^FALSIFIER: ... | ...` format is unchanged.

### O4 — gate-call try-placement — non-blocking — ACCEPT-and-revise

Candidate: a throw from the gate outside the existing `try`/`catch` would escape the
inbound loop.
- [citation] `src/runtime/runtime.ts:654-663` — `try { this.handleEnvelope(env, connId, socket); } catch (err) { ... event: "envelope-handler-threw" ... socket.destroy(); }` already wraps the dispatch.

Fix applied: §1.2 now states the gate call sits inside that existing `try` block, so a
contract-violating throw is contained by the existing `envelope-handler-threw`
logging and socket-destroy path.

Owner disposition: O1, O2, O3, O4 all ACCEPT-and-revise, applied in this revision. No
claim withdrawn; no objection rebuffed.
