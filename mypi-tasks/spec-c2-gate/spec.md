# spec.md — C2 peer→supervisor injection gate: functional & UX specification

Owner: `spec_author` (sole writer of this file)
[citation] `.mypi/spec-c2-gate/run-details/plan.md:15` — "Ownership rule: exactly one writer per file; no peer edits another's file."

Contract consumed: `DC-JEV-C2-GATE`, `Version 1.1.0`, `Status FROZEN`.
[citation] `.mypi/spec-c2-gate/data-contracts.md:10-12` — "| Contract id | `DC-JEV-C2-GATE` |", "| Version | `1.1.0` |", "| Status | `FROZEN` |".
[citation] `.mypi/spec-c2-gate/data-contracts.md:15` — "| Amended | 2026-10-13: v1.0.0 → v1.1.0 (`§Amendment 2026-10-13`, supervisor-relayed) |". Every version reference in this document reads `1.1.0`; the delta this document consumes is `§Amendment 2026-10-13`, `.mypi/spec-c2-gate/data-contracts.md:405-429` (items A1-A7).

Docs-only run: [citation] `.mypi/spec-c2-gate/run-details/plan.md:3-4` —
"Branch: `spec-c2-gate` (unmerged, never merged). Task root:
`.mypi/spec-c2-gate/`. Docs only."

## §0 Consumption rule (anchor: §0)

Every field, enum member, literal, config key, and level name below is quoted
from `data-contracts.md` §2–§9 verbatim, written as `Record.field`. This document
specifies behaviour only — screens, actions, states, and acceptance checks. It
defines no type, no interface, no schema, no wire format, and no local alias for
anything the contract owns.

[citation] `.mypi/spec-c2-gate/data-contracts.md:21-23` — "those documents consume
these field names, types, nullability, enums, IDs, and ordering verbatim and
define no local schema variants."

Evidence classes: [citation] `.mypi/spec-c2-gate/run-details/plan.md:42-44` —
"`exec-here` (command run in this workspace, raw output pasted) · `citation`
(`path:line` + quoted text) · `reasoned` (named assumptions…)".

Anchors: §0 rule · §1 states · §2 FLAGGED · §3 UNFLAGGED · §4 THRESHOLD ·
§5 LOG-AND-CONTINUE · §6 CLASSIFIER-ERROR FALLBACK · §7 scope · §8 UX ·
§9 non-goals · §10 acceptance checks · §11 gaps · §12 Falsifiers ·
§13 verification log · §14 Opposition disposition (DD-2).

## §1 Actors, surfaces, gate states (anchor: §1)

- **Inbound frame**: an `A2AEnvelope` that `classifyFrame` classified `valid`.
  [citation] `src/bus/message-validator.ts:17-28` — "`export function
  classifyFrame(line: string): FrameClassification {`" … "`return { kind:
  \"valid\", envelope: env.data };`" (line 28). The gate runs downstream of that
  verdict and never re-validates structure (contract F5,
  `.mypi/spec-c2-gate/data-contracts.md:32`).
- **Insertion point**: the runtime inbound loop that hands a valid envelope to
  agent routing. [citation] `src/runtime/runtime.ts:643` — "`const env =
  routeFrame(line, {`" and `src/runtime/runtime.ts:653-655` — "`if (env !==
  undefined) {`" … "`this.handleEnvelope(env, connId, socket);`". Locates as
  gate insertion point in [citation] `.mypi/spec-c2-gate/run-details/plan.md:24`.
- **Supervisor surface**: peer prose reaches the supervisor through
  [citation] `src/pi/extension.ts:569-570` — "`const p = reply.payload as {
  text?: string; report?: string };`" "`return p.text ?? p.report ?? \"\";`".
- **Run-log surface**: `InjectionGateLogEntry` records are appended as JSONL
  [citation] `src/logging/conversation-log.ts:9-10` — "`append(entry:
  Record<string, unknown>): Promise<void> {`" "`return appendFile(this.path,
  \`${JSON.stringify(entry)}\\n\`);`"; file
  [citation] `src/runtime/runtime.ts:180` — "`new ConversationLog(join(this.runDetailsDir, \"conversation.jsonl\"))`".

Gate states (per frame). [reasoned — assumption named: the contract defines one
`InjectionScreenInput`, one `InjectionScreenResult`, and one
`InjectionGateDecision` per screened frame (contract §3–§5) and gives no record a
field that spans frames, so the gate holds no cross-frame state; a `citation`
for this is impossible because no contract line states it either way]

| State                | Reached when                                                                                      | Emitted                                                                                | Routing effect |
| -------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------- |
| `OFF`                | `session.jev.injection_check` is `false`, or `session.jev` is absent                              | nothing — "Gate is inert (emits nothing) when `false` or when `session.jev` is absent" | none           |
| `NOT-SCREENED`       | gate `ON` and `A2AEnvelope.type` is not a `ScreenedEventType` member (§7)                         | nothing                                                                                | none           |
| `SCREENED-UNFLAGGED` | `InjectionGateDecision.flagged` evaluates false under the §4 comparator                           | one `InjectionGateLogEntry` at `InjectionGateLogLevel` `info`                          | none           |
| `SCREENED-FLAGGED`   | `InjectionGateDecision.flagged` evaluates true (§2, §4, §6, including the §6 non-resolution case) | one `InjectionGateLogEntry` at `InjectionGateLogLevel` `warn`                          | none           |

[citation] `.mypi/spec-c2-gate/data-contracts.md:48` — "| `session.jev.injection_check` | `z.boolean().default(false)` | `false` | Gate opt-in. Gate is inert (emits nothing) when `false` or when `session.jev` is absent."

[exec-here] None of the three new keys exists in the shipped schema yet: `grep -n "injection"
src/contracts/session-schema.ts` → no output, exit code 1. They are additions,
not renames — same finding as contract F7
(`.mypi/spec-c2-gate/data-contracts.md:34`).

## §2 FLAGGED — what the supervisor sees and does (anchor: §2)

**Trigger.** Gate `ON`; a `valid` inbound frame whose
`A2AEnvelope.type` is `FINAL_REPORT` or `RESPONSE` (`ScreenedEventType`,
[citation] `.mypi/spec-c2-gate/data-contracts.md:85`); the gate assembled one
`InjectionScreenInput` and the resulting
`InjectionScreenResult.flagged` is true, so `InjectionGateDecision.flagged` is
true [citation] `.mypi/spec-c2-gate/data-contracts.md:158` — "flagged: boolean; // required, never null; screens.some(s => s.flagged) (§8)",
with the disjunction and "Flagged wins" at
`.mypi/spec-c2-gate/data-contracts.md:252-254`.

**Observable — the exact fields the supervisor's annotation exposes.**
`InjectionGateDecision` (contract §5,
`.mypi/spec-c2-gate/data-contracts.md:149-160`):
- `InjectionGateDecision.gate` = the literal `jev-injection-gate` (line 150)
- `InjectionGateDecision.contractVersion` = the literal `1.1.0` (line 151)
- `InjectionGateDecision.frameId` (line 152) — envelope linkage, contract F2
  [citation] `.mypi/spec-c2-gate/data-contracts.md:29` — "Frame identity for
  linkage is `id`; `correlationId` is optional."
- `InjectionGateDecision.correlationId` (line 153) — `string | null`
- `InjectionGateDecision.sender` (line 154)
- `InjectionGateDecision.eventType` (line 155) — `FINAL_REPORT` | `RESPONSE`
- `InjectionGateDecision.model` (line 156) — `session.jev.model` echo
- `InjectionGateDecision.threshold` (line 157) — `session.jev.injection_threshold` echo
- `InjectionGateDecision.flagged` (line 158)
- `InjectionGateDecision.screens` (line 159) → per element
  `InjectionScreenResult.screenedField`, `.score`, `.threshold`, `.flagged`,
  `.error` (contract §4, `.mypi/spec-c2-gate/data-contracts.md:129-138`)

`InjectionScreenResult.screenedField` is the "which payload field was screened"
discriminator [citation]
`.mypi/spec-c2-gate/data-contracts.md:133` — "`screenedField: ScreenedField; // the screened-field discriminator: which payload field was screened`".

**Observable — the log line.** One `InjectionGateLogEntry` with
`InjectionGateLogEntry.level` = `warn` and `InjectionGateLogEntry.event` =
`injection_flagged`, derived by the frozen rule [citation]
`.mypi/spec-c2-gate/data-contracts.md:269-271` — "// error !== null => \"injection_classifier_error\" // else flagged => \"injection_flagged\" // else => \"injection_screened\" (the default)" and
`.mypi/spec-c2-gate/data-contracts.md:275` — "// Derived: \"warn\" iff flagged === true; else \"info\" (the default)."

**Observable — the frame is not suppressed.** [citation]
`.mypi/spec-c2-gate/data-contracts.md:143-145` — "This record is the annotation
attached to the frame and delivered to the supervisor context; the gate
annotates, it does not alter `classifyFrame`/`routeFrame` return contracts".

**Delivery path (revised for DD-2, §14/O1).** The sentence just quoted is contract
prose about the record's role; in this document "delivered to the supervisor
context" is satisfied by the `InjectionGateLogEntry` log/audit path. The entry is
appended to `conversation.jsonl` (§1 run-log surface) and carries
`frameId`/`sender`/`event`/`screenedField`, so the supervisor observes the flag
without any wire-level change. Threading the record into a later supervisor prompt
is transport plumbing owned by `implementation-plan.md`, and that plumbing must NOT
modify `A2AEnvelopeSchema` nor add a key to `A2AEnvelope`: the envelope is a
`z.strictObject` [exec-here] `grep -n "A2AEnvelopeSchema = z.strictObject"
src/contracts/a2a-schema.ts` → `147:export const A2AEnvelopeSchema = z.strictObject({`,
so any attached key is rejected as `unrecognized_keys` rather than carried. This
revision removes a claim this document could not evidence: the supervisor prose
surface forwards payload text only, [exec-here]
`sed -n '569,570p' src/pi/extension.ts` → `  const p = reply.payload as { text?: string; report?: string };` /
`  return p.text ?? p.report ?? "";`.
The peer's own `InjectionScreenInput.content` is neither rewritten nor removed;
the supervisor reads it via the existing `replyText` path (§1).

**Supervisor actions on a flag** (existing vocabulary only):
- Treat the flagged `InjectionScreenResult.screenedField` prose as untrusted
  assertion rather than instruction; re-derive any claim it makes from the
  peer's artifacts before acting on it.
- Locate the frame again by `InjectionGateDecision.frameId`, and join its
  request thread by `InjectionGateDecision.correlationId` when non-null.
- Escalate through the deterministic vocabulary when the flag corroborates a
  real fault: `STOP_AGENT`, `STOP_ALL`, `KILL_ALL` are existing `EVENT_TYPES`
  members [citation] `src/contracts/a2a-schema.ts:9-32` (contract F1,
  `.mypi/spec-c2-gate/data-contracts.md:28`).
- Record the outcome in the run's own documents. A flag is advisory: it does not
  change the exit code and does not gate finalization (§9).

**Acceptance checks:** AC-1, AC-2, AC-3, AC-4, AC-36.

## §3 UNFLAGGED — pass path and no-op proof (anchor: §3)

**Trigger.** Gate `ON`; frame screened; `InjectionGateDecision.flagged`
evaluates false, i.e. `InjectionScreenResult.score` resolved inside `[0,1]` and
strictly below `InjectionScreenResult.threshold`.

**Observable.** One `InjectionGateLogEntry` at `InjectionGateLogLevel` `info`
with `InjectionGateEvent` `injection_screened` — the documented default
[citation] `.mypi/spec-c2-gate/data-contracts.md:264` — "| \"injection_screened\" // default".
Delivery is otherwise identical to the gate being off.

**No-op proof.**
1. The gate's output is a record, not a routing verdict. [citation]
   `.mypi/spec-c2-gate/run-details/plan.md:57` — "DD-1 | Gate returns a decision
   record and the frame is _annotated_, not routed differently: `routeFrame`'s
   valid/undefined return contract is unchanged."
2. Routing disposition lives in the router, which the gate never calls:
   [citation] `src/bus/router.ts:25-29` — "`const c = classifyFrame(line); if
   (c.kind === \"f1\") { deps.malformed(c.reason); deps.log({ event: \"f1\", reason: c.reason }); return undefined; }`".
   Only `f1`/`f2` produce that `undefined`; a screened `valid` frame never takes
   either branch (contract F5, `.mypi/spec-c2-gate/data-contracts.md:32`).
3. `SCREENED-UNFLAGGED` and `SCREENED-FLAGGED` in §1 have the same routing
   effect column value: none. The only side effect of a screen is one log line.
4. [reasoned — assumption named: "no-op on routing" is provable only as the
   absence of a routing call, since behaviour tests are out of scope for this
   docs-only run (`plan.md:3-4`). The structural proofs are (1)–(3): the gate is
   not on the branch that can return `undefined`, so removing the gate and
   leaving it on produce identical routing.] The deferred code-level proofs are
   AC-26 and AC-27.

**Acceptance checks:** AC-5, AC-6, AC-7, AC-8.

## §4 THRESHOLD — comparator, key path, bounds, default, boundary (anchor: §4)

**Comparator (contract §7, verbatim).** `flagged = score === null || score >=
threshold`
[citation] `.mypi/spec-c2-gate/data-contracts.md:209-210` — "- Comparator:
`flagged = score === null || score >= threshold`. Equality flags (`>=`, not
`>`)." The per-screen record states the same rule
[citation] `.mypi/spec-c2-gate/data-contracts.md:136`.

**Config key path.** `session.jev.injection_threshold`, read at gate execution,
never a code constant. [citation]
`.mypi/spec-c2-gate/data-contracts.md:213-215` — "The threshold is a CONFIG
value read from `session.jev.injection_threshold` (§2) at gate execution — never
a code constant."; key name frozen at
`.mypi/spec-c2-gate/run-details/plan.md:60` (DD-4).

**Config surface — the three gate keys, all read at gate execution.**

| Config key                         | Zod shape                               | Default | Gate use                    | Note                                                                      |
| ---------------------------------- | --------------------------------------- | ------- | --------------------------- | ------------------------------------------------------------------------- |
| `session.jev.injection_check`      | `z.boolean().default(false)`            | `false` | total off-switch            | gate inert when `false` or when `session.jev` is absent                   |
| `session.jev.injection_threshold`  | `z.number().gt(0).lt(1).default(0.8)`   | `0.8`   | the comparator operand      | open interval `(0,1)`                                                     |
| `session.jev.injection_timeout_ms` | `z.number().int().gte(0).default(2000)` | `2000`  | the §6 non-resolution bound | integer milliseconds; `0` disables the bound (see §6 for the consequence) |

[citation] `.mypi/spec-c2-gate/data-contracts.md:48-50` — the three §2 rows:
"| `session.jev.injection_check` | `z.boolean().default(false)` | `false` | …",
"| `session.jev.injection_threshold` | `z.number().gt(0).lt(1).default(0.8)` | `0.8` | …",
"| `session.jev.injection_timeout_ms` | `z.number().int().gte(0).default(2000)` | `2000` | Gate call-site race bound. A seam promise unsettled after this many milliseconds (non-zero) is a classifier error (§3, §6). `0` disables the bound."

**Bounds and default.** `z.number().gt(0).lt(1).default(0.8)` — open interval
`(0,1)`, default `0.8` [citation]
`.mypi/spec-c2-gate/data-contracts.md:49`. Rationale for `0.8` at
`.mypi/spec-c2-gate/data-contracts.md:55-58` ("exclusive of the measured ~0.03
run-to-run spread … far from the `p=0.99` true-injection probe"). Shape
precedent in the shipped schema: [citation]
`src/contracts/session-schema.ts:46` — "`review_threshold:
z.number().gt(0).lt(1).default(0.5),`".

**Key isolation.** The gate reads `session.jev.injection_threshold` only.
`session.jev.review_threshold` is marked "**Not read by the gate**" and the two
thresholds run in opposite directions [citation]
`.mypi/spec-c2-gate/data-contracts.md:216-220` — "higher `review_threshold`
means \"harder to pass a verdict\"; higher `injection_threshold` means \"harder
to flag a frame\". Consumers must never read one for the other." `session.jev.model`
is reused as the classifier slug (`.mypi/spec-c2-gate/data-contracts.md:51`);
`session.jev.verdict_check` is not read by the gate
(`.mypi/spec-c2-gate/data-contracts.md:52`).

**Trigger → observable at the boundary** (with
`session.jev.injection_threshold` = `0.8`):

| `InjectionScreenResult.score`  | `InjectionScreenResult.flagged`         | `InjectionGateLogEntry.event` | `InjectionGateLogEntry.level` | Delivered? |
| ------------------------------ | --------------------------------------- | ----------------------------- | ----------------------------- | ---------- |
| `0.7999`                       | false                                   | `injection_screened`          | `info`                        | yes        |
| `0.8` — exactly `== threshold` | true                                    | `injection_flagged`           | `warn`                        | yes        |
| `0.81`                         | true                                    | `injection_flagged`           | `warn`                        | yes        |
| `null` (classifier error)      | true, independent of the threshold (§6) | `injection_classifier_error`  | `warn`                        | yes        |

The boundary is observable: at `score` exactly `== threshold` the frame flips to
`flagged` = true and the log line flips from `info`/`injection_screened` to
`warn`/`injection_flagged`. An implementation using strict `>` differs from this
spec only at that one point and is non-conforming. Null score is handled by the
comparator's left operand: it flags whatever the threshold value is
[citation] `.mypi/spec-c2-gate/data-contracts.md:211-212`.

**Auditability.** Every record echoes the value used, so an annotation stays
readable after a config change [citation]
`.mypi/spec-c2-gate/data-contracts.md:221-222`.

**Variance caveat.** The classifier is not deterministic (~0.03 spread), so a
score within the spread of the threshold flips run to run and one unflagged
screen is not a safety guarantee [citation]
`.mypi/spec-c2-gate/data-contracts.md:223-225`; measurement at
`.mypi/spec-c2-gate/data-contracts.md:37` (F10).

**Equality boundary is a stub-level assertion.** The comparator has no epsilon
rule: `InjectionScreenResult.score` is compared as the number the seam resolved.
[reasoned — assumptions named: (a) the seam's number reaches the comparator
unchanged, so the boundary row above is deterministic only when the score is
supplied, not when it is produced by a live classifier call, which re-samples
inside the ~0.03 spread (F10); (b) no `data-contracts.md` section describes
rounding. Therefore the acceptance evidence for `score === threshold` is the
unit test against the `InjectionEstimate` seam, never an integration run.] The
integration path verifies direction (a planted instruction flags, a plain report
does not), not the boundary value.

**Reach limits of the config value.** Because `session.jev.injection_threshold`
is confined to the open interval `(0,1)`, no legal value means "never flag" (a
`score` of `1` flags at every legal threshold) and none means "always flag" (a
`score` of `0` never flags at the legal minimum). `session.jev.injection_check`
is the only total switch: `false` stops the gate from evaluating at all
(`injection_check` is `z.boolean().default(false)` and is also what makes the
gate inert when `session.jev` is absent, contract §2 line 48).

**Integration surface is not real yet.** The three keys are additions to
`session.jev`, whose shipped shape is [citation]
`src/contracts/session-schema.ts:41-47` — "`const JevSchema = z.strictObject({`"
… "`review_threshold: z.number().gt(0).lt(1).default(0.5),`" "`});`", mounted as
[citation] `src/contracts/session-schema.ts:78` — "`jev: JevSchema.optional(),`".
[exec-here] evaluating that shape with `{injection_check: true,
injection_threshold: 0.8, injection_timeout_ms: 2000}` returns `success: false`
with issue code `"unrecognized_keys"` and
`keys: ["injection_check","injection_threshold","injection_timeout_ms"]` — a
strictObject rejects the three new keys until the schema block itself is amended.
Landing them requires an **additive `JevSchema` delta**: three new rows inside the
existing block at `src/contracts/session-schema.ts:41-47`, no existing key
renamed, repurposed, or removed. That code delta is owned by
`implementation-plan.md`, not by this document [citation]
`.mypi/spec-c2-gate/data-contracts.md:68-77` — "The three gate keys
(`injection_check`, `injection_threshold`, `injection_timeout_ms`) are NEW …
Landing the keys requires an additive `JevSchema` delta — three new rows inside
the existing block at `src/contracts/session-schema.ts:41-47` … That code delta
is owned by `implementation-plan.md`, not by this contract." So enabling the gate
is a code change plus a config change, not config alone, and a session that sets
the keys before that delta fails to parse rather than silently ignoring them.

**Acceptance checks:** AC-9, AC-10, AC-11, AC-12, AC-13, AC-32, AC-33, AC-37, AC-38.

## §5 LOG-AND-CONTINUE — the default disposition (anchor: §5)

Decision owned by this document: DD-2.
[citation] `.mypi/spec-c2-gate/run-details/plan.md:58` — "| DD-2 |
`log-and-continue` is the default disposition: a flagged frame is still
delivered, so the gate can never drop a valid frame. | `spec_author` |
`implementation_planner` | … |" — the status cell is elided: the round record
supersedes the queue row, and the cell now reads `CLOSED — falsifier not triggered
(anchor found); no blocking objection; 1 non-blocking accepted`, which §14 restates
in full.

**Trigger.** Gate `ON`; frame screened; `InjectionGateDecision.flagged` true —
whether by score, by null score (§6), by the §6 non-resolution bound, or by the
`screens.some(s => s.flagged)` disjunction.

**Disposition.** Log and continue. The frame is annotated and still delivered;
the gate never drops a valid frame. [citation]
`docs/jev/implementation-plan.md:104-105` — "`src/jev/injection-gate.ts`
screens valid inbound frame **content**; log-and-continue only." and
`docs/jev/implementation-plan.md:81-83` — "**T3 — `src/jev/injection-gate.ts`
unit tests** … the adopted **log-and-continue** policy: a flagged inbound frame
is annotated and still delivered (never dropped)."

**Exact log fields and levels** — one `InjectionGateLogEntry` per screen
(contract §9, `.mypi/spec-c2-gate/data-contracts.md:262-289`):

| Field                                 | Value on a flagged frame                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `InjectionGateLogEntry.at`            | epoch milliseconds (line 278)                                                                                                          |
| `InjectionGateLogEntry.level`         | `warn` — the closed union is `"info" \| "warn"` (line 273); `warn` iff flagged (line 275)                                              |
| `InjectionGateLogEntry.event`         | `injection_flagged`; `injection_classifier_error` if `InjectionScreenResult.error` non-null; else `injection_screened` (lines 263-271) |
| `InjectionGateLogEntry.frameId`       | echo of `InjectionScreenInput.frameId` (line 281)                                                                                      |
| `InjectionGateLogEntry.correlationId` | `string \| null`, null iff omitted on the envelope (line 282)                                                                          |
| `InjectionGateLogEntry.sender`        | echo (line 283)                                                                                                                        |
| `InjectionGateLogEntry.screenedField` | `report` \| `text` (line 284)                                                                                                          |
| `InjectionGateLogEntry.score`         | `number \| null` (line 285)                                                                                                            |
| `InjectionGateLogEntry.threshold`     | echo of `session.jev.injection_threshold` (line 286)                                                                                   |
| `InjectionGateLogEntry.flagged`       | `boolean` (line 287)                                                                                                                   |
| `InjectionGateLogEntry.error`         | `string \| null`, non-empty iff `score` null (line 288)                                                                                |

A screen that ended in the §6 non-resolution case fills the same row set: `score`
`null`, `error` naming the bound, `event` = `injection_classifier_error`, `level` =
`warn`. No log field, event, or level is added for the timeout; the record shape is
unchanged by §Amendment A2.

`InjectionGateDecision` is the annotation record attached to the delivered
frame (§2). No third record type and no additional level exist: the unions are
closed and the nullability table lists no other nullable field
[citation] `.mypi/spec-c2-gate/data-contracts.md:305-308` — "No other field is
nullable."

**Ordering of the emitted artifacts** (contract §8):
`InjectionGateDecision.screens` sorted by `ScreenedField` ordinal, `"report"`
(0) before `"text"` (1); log entries sorted by `at` ascending, tie-break
`frameId` ascending, then `ScreenedField` ordinal
[citation] `.mypi/spec-c2-gate/data-contracts.md:247-248`.

**Why continue rather than drop** [reasoned — assumptions named: (a) the
supervisor, not a probabilistic classifier, is the authority over peer output;
(b) `classifyFrame`/`routeFrame` already own disposition deterministically
(F5/DD-1); (c) the classifier is non-deterministic (F10), so a drop-on-flag
turns every false positive into a lost work order. Given (a)–(c), the smallest
disposition that still surfaces the signal is log-and-continue]. It mirrors the
shipped C1 rule that a Jev advisory never becomes the gate [citation]
`src/jev/verdict-advisory.ts:3-5` — "it is written to final.md and returned to
the supervisor, and NEVER changes the exit code".

**Acceptance checks:** AC-14, AC-15, AC-6, AC-7, AC-16.

## §6 CLASSIFIER-ERROR FALLBACK (anchor: §6)

**Trigger.** The call seam `InjectionEstimate = (content: string) =>
Promise<number>` [citation]
`.mypi/spec-c2-gate/data-contracts.md:109` either rejects, resolves to a
non-number, `NaN`/`Infinity`, or a number outside `[0,1]`. [citation]
`.mypi/spec-c2-gate/data-contracts.md:113-117` — "any rejection, any non-number,
any `NaN`/`Infinity`, or any number outside `[0,1]` is a **classifier error**
and MUST be converted by the gate into the fallback screen record (§6) — never
thrown, never an implicit pass."

**Observable.** The gate emits the frozen fallback screen record and nothing
else for that screen (contract §6,
`.mypi/spec-c2-gate/data-contracts.md:168-180`):
`InjectionScreenResult.score` = `null` ·
`InjectionScreenResult.flagged` = `true` ·
`InjectionScreenResult.error` = a non-empty message ·
`InjectionScreenResult.threshold` still echoed from config ·
`InjectionScreenResult.frameId` / `.correlationId` / `.sender` / `.screenedField`
carried from `InjectionScreenInput`. DD-3 as frozen: `flagged: true, error: <string>, score: null`
[citation] `.mypi/spec-c2-gate/run-details/plan.md:59`.

Consequences, in order: frame-level `InjectionGateDecision.flagged` becomes true
by the disjunction (§5); the comparator flags on the null operand alone (§4);
the log line is `InjectionGateLogEntry.event` = `injection_classifier_error` at
`InjectionGateLogLevel` = `warn`; and the frame is still delivered (§5). The
supervisor sees a flag that means "unknown", not "clean" and not "guilty".

**Non-resolution — the bounded-wait case (A1-A3, contract §Amendment 2026-10-13).**

**Trigger.** Gate `ON`; frame screened; `session.jev.injection_timeout_ms` is
non-zero; the `InjectionEstimate` promise is still unsettled when the bound
elapses. [citation] `.mypi/spec-c2-gate/data-contracts.md:112-119` — "any
rejection, any non-number, any `NaN`/`Infinity`, any number outside `[0,1]`, or a
promise unsettled after `session.jev.injection_timeout_ms` milliseconds (§2;
non-zero — `0` disables the bound) is a **classifier error** and MUST be
converted by the gate into the fallback screen record (§6) — never thrown, never
an implicit pass. The timeout race is owned by the gate call site: it is
transport plumbing and never a field inside any record defined in this
contract."

**Observable.** The same fallback record as any other classifier error:
`InjectionScreenResult.score` = `null` ·
`InjectionScreenResult.flagged` = `true` ·
`InjectionScreenResult.error` = a non-empty message naming the bound, the
contract's example being `"classify failed: timeout after 2000 ms"` [citation]
`.mypi/spec-c2-gate/data-contracts.md:189-190`. The screen continues rather than
stalling: `InjectionGateLogEntry.event` = `injection_classifier_error` at
`InjectionGateLogLevel` = `warn`, and the frame is delivered (§5). The bound adds
no record field, no event name and no level — it lives at the gate call site — so
§7's "no new record, field, enum member, level, event name, or config key" holds.

**Acceptance check: AC-35.**

**`session.jev.injection_timeout_ms`: `0` disables the bound — the consequence,
stated plainly.** With `0` the gate applies no local bound, so a seam that never
settles suspends the inbound path at the insertion point (§1): no
`InjectionScreenResult`, no `InjectionGateDecision`, no `InjectionGateLogEntry`,
and the frame is neither flagged nor delivered.
`0` therefore restores unbounded waiting. It is not "no timeout
error" and it is not an off-switch: choosing `0`
re-opens exactly the non-resolution hole the bound closes, and the safe setting is
the non-zero default. [citation]
`.mypi/spec-c2-gate/data-contracts.md:50` — "`0` disables the bound."; the
default `2000` sits ~2.3x above the worst measured classifier latency (170-870
ms) [citation] `.mypi/spec-c2-gate/data-contracts.md:63-65`. No record can
distinguish "gate off" from "gate on, seam hung": in both cases nothing is
emitted, which is the silence already recorded as gap A5 (§11).

**Never an implicit pass, never a throw.** [citation]
`.mypi/spec-c2-gate/data-contracts.md:182-183` — "Never an implicit pass
(`flagged` is never `false` with a null `score`) and never a
throw: a classifier failure must not break inbound delivery." Nullability
agrees: [citation] `.mypi/spec-c2-gate/data-contracts.md:300` —
"`InjectionScreenResult.score` … Treat the frame as flagged; never as an
implicit pass". Application to the non-resolution case: a hang is a classifier
failure that never reaches the comparator, so the only thing that keeps it out of
the inbound path is the call-site race; with the bound non-zero the outcome is
the fail-closed record above, which is what makes AC-34's null-score rule reach
this case at all.

**The `score === null ||` guard is load-bearing.** The comparator read in
isolation, `score >= threshold`, is **false** on a null operand, which would turn
the fallback into an implicit pass [exec-here]
`node -e 'console.log(JSON.stringify({bare:null>=0.8,
 guarded:(null===null||null>=0.8)}))'` →
`{"bare":false,"guarded":true}`. The guard is therefore a behaviour, not
cosmetics, and AC-34 asserts it. [reasoned] this reproduces DD-3 opponent C1's
measurement; the guard is contract text (`.mypi/spec-c2-gate/data-contracts.md:209`),
so the assertion is against frozen text, not against a preference.

**Mirror of the shipped precedent `src/jev/verdict-advisory.ts`** (contract F8,
`.mypi/spec-c2-gate/data-contracts.md:35`):
- the failed call is caught locally, never propagated — [citation]
  `src/jev/verdict-advisory.ts:43-47` — "`try { establishes = await estimate(…); }
  catch { establishes = null; }`" (line 46: "`establishes = null;`");
- the null result flags, it does not pass — [citation]
  `src/jev/verdict-advisory.ts:51` — "`flagged: establishes === null || establishes < threshold,`"
  (the gate keeps the same null short-circuit with the direction its signal
  needs: `score === null || score >= threshold`, §4);
- the advisory never becomes the gate — [citation]
  `src/jev/verdict-advisory.ts:3-4` — "NEVER changes the exit code", and
  `src/jev/verdict-advisory.ts:31-32` — "A failed call is flagged (unknown, not
  a pass), never thrown — the advisory must not break finalization." For C2 the
  thing that must not break is the inbound delivery path, and the disposition is
  identical: contain the failure, flag it, keep going.

**Acceptance checks:** AC-16, AC-17, AC-18, AC-6, AC-34, AC-35.

## §7 Scope boundary — screened and not screened (anchor: §7)

**Screened — the closed `ScreenedEventType` subset, two members**
[citation] `.mypi/spec-c2-gate/data-contracts.md:85` — "`export type
ScreenedEventType = \"FINAL_REPORT\" | \"RESPONSE\";`", and F1's rule
`.mypi/spec-c2-gate/data-contracts.md:28` — "This is the only event vocabulary;
the gate screens a closed two-value subset (§3)."

| `A2AEnvelope.type` | `InjectionScreenInput.screenedField` | Field screened                | Schema locator                                                                                               |
| ------------------ | ------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `FINAL_REPORT`     | `report`                             | `FINAL_REPORT.payload.report` | [citation] `src/contracts/a2a-schema.ts:121` — "`report: z.string(),`" (contract F4, `data-contracts.md:31`) |
| `RESPONSE`         | `text`                               | `RESPONSE.payload.text`       | [citation] `src/contracts/a2a-schema.ts:72` — "`text: z.string(),`" (contract F3, `data-contracts.md:30`)    |

The mapping is derived, never chosen: `"FINAL_REPORT" => "report"`,
`"RESPONSE" => "text"` [citation]
`.mypi/spec-c2-gate/data-contracts.md:90-92`.

**Not screened, and why.**
- The other 20 `EVENT_TYPES` members — outside the frozen subset; screening them
  would require an amendment, not a spec-side choice.
- `PROMPT.payload.text` [citation] `src/contracts/a2a-schema.ts:69` — "`PROMPT:
  z.strictObject({ agentId, text: z.string() }),`" — direction is
  supervisor→peer, so it is not peer-authored prose entering the supervisor's
  context; C2's hole is the inbound one [citation]
  `docs/jev/integration-map.md:56-58` — "A peer's report/prompt text is fed into
  the supervisor's context with no semantic screening".
- `FINAL_REPORT.payload.criteria`, `.usage`, `.agentId` and `RESPONSE`'s same —
  structured, schema-validated values already covered by the two-pass
  `classifyFrame` check (F5) and by the deterministic criteria/attester gates;
  screening them buys cost and false positives, not coverage of a prose hole.
- Every `A2AEnvelope` field (`id`, `correlationId`, `timestamp`, `sender`,
  `recipient`, `type`) — envelope metadata, not content; `strictObject`
  validation is the gatekeeper there
  ([citation] `src/contracts/a2a-schema.ts:147` — "`export const
  A2AEnvelopeSchema = z.strictObject({`").
- `ERROR.payload.message`, `AGENT_UNUSABLE.payload.reason`,
  `AGENT_CRASHED.payload.reason` — runtime/bus-generated strings, not peer
  report prose, and outside the subset.
- Anything not in the frame: the gate's only input is
  `InjectionScreenInput.content`; it never opens a peer's files or artifacts.

**Acceptance checks:** AC-19, AC-20, AC-21.

## §8 Supervisor UX — reading a flag (anchor: §8)

| What the supervisor can observe                                                | Meaning                                                                                                                                                   | What it does NOT mean                                                 |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| no `injection_*` line for a frame                                              | gate `OFF` (`session.jev.injection_check` false or `session.jev` absent), or `NOT-SCREENED` type (§7)                                                     | that the content was checked and found clean                          |
| `injection_screened` at `info`                                                 | `InjectionScreenResult.score` below `InjectionScreenResult.threshold`                                                                                     | a guarantee of safety — non-deterministic classifier (§4, F10)        |
| `injection_flagged` at `warn`                                                  | `InjectionScreenResult.score >= threshold`                                                                                                                | that the frame was blocked or its text removed — it is delivered (§5) |
| `injection_classifier_error` at `warn`, `InjectionScreenResult.score` = `null` | the classifier produced no usable probability — a rejected/failed call or a seam unsettled past `session.jev.injection_timeout_ms`; fail-closed flag (§6) | that the peer misbehaved                                              |

Reading order supported by the delivered annotation alone (no cross-document
join needed): `InjectionGateDecision.sender` (which peer) →
`InjectionGateDecision.eventType` + `InjectionScreenResult.screenedField` (which
payload field) → `InjectionScreenResult.score` against
`InjectionScreenResult.threshold` (how close to the boundary: a `0.81` against
the `0.8` default sits inside the ~0.03 spread, a `0.99` is the probe-grade
signal in F10) → `InjectionGateDecision.model` (which classifier) →
`InjectionGateDecision.contractVersion` (which contract) →
`InjectionGateDecision.frameId` / `.correlationId` (how to get the frame back).

Rendering rules the UX must follow, from the contract's nullability table:
- `InjectionGateDecision.correlationId` null renders as "no correlation", never
  as a synthesized placeholder [citation]
  `.mypi/spec-c2-gate/data-contracts.md:298` — "Pass through verbatim; never
  synthesize a placeholder string".
- `InjectionScreenResult.score` null renders as absent/`—` alongside
  `InjectionScreenResult.error`, never as `0` — `0` reads as "definitely clean"
  and would invert §6.
- `InjectionScreenResult.error` null renders as nothing (line 301: "No
  behavioural branch; log/serialize as-is").
- A bound-named `InjectionScreenResult.error` (e.g. `"classify failed: timeout
after 2000 ms"`) renders as the classifier-error case: unknown, not a pass, and
  not evidence about the peer (§6).

**Acceptance checks:** AC-22, AC-23.

## §9 Non-goals (anchor: §9)

- No veto, hold, quarantine, suppression, or drop path. DD-2 (this document) and
  DD-1 (pipeline) fix annotate-only.
- No change to the exit code, `Runtime.runSucceeded`, finalization, or the
  deterministic criteria/attester gates — the C1 precedent binds
  (`src/jev/verdict-advisory.ts:3-4`).
- No new record, field, enum member, level, event name, or config key. Additions
  reach this document only through the contract's amendment rule
  [citation] `.mypi/spec-c2-gate/data-contracts.md:16` — "| Amendment rule |
  After freeze this document changes only via a targeted canonical amendment …
  No consumer may fork, rename, or locally redefine any record, field, enum, or
  key named here."
- No retry, no second opinion, no score averaging and no max-score rule: the
  frame-level disjunction with "Flagged wins" is the frozen tie-break
  [citation] `.mypi/spec-c2-gate/data-contracts.md:253-256`.
- No screening of outbound frames or of types outside `ScreenedEventType`.
- No operator UI beyond the run-log line plus the delivered annotation; where the
  annotation is placed in the supervisor's context is
  `pipeline_spec_author`'s `ingestion-spec.md`, not this document.

## §10 Acceptance checks (anchor: §10)

`SPEC` = `.mypi/spec-c2-gate/spec.md`. `BODY` = `sed -n '1,/^## §10 Acceptance checks/p' SPEC`
— the normative sections only, so that a negative check cannot be tripped by
the text of its own command in this table.

Now = runnable in this workspace against these documents. Deferred = runnable
once `src/jev/injection-gate.ts` exists; this run writes no application code
(`plan.md:3-4`), so today the file is absent
([exec-here] `ls src/jev/` → `verdict-advisory.ts`).

| #     | Section    | Behaviour checked                                                                                                              | Command                                                                                                                          | Expected                                                                                                                       | When                                                      |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| AC-1  | §2         | the flag field is named by contract path                                                                                       | `grep -c "InjectionGateDecision.flagged" $BODY`                                                                                  | ≥ 1                                                                                                                            | now                                                       |
| AC-2  | §2         | the per-screen discriminator is named                                                                                          | `grep -c "InjectionScreenResult.screenedField" $BODY`                                                                            | ≥ 1                                                                                                                            | now                                                       |
| AC-3  | §2         | the flag event literal is used                                                                                                 | `grep -c "injection_flagged" $BODY`                                                                                              | ≥ 1                                                                                                                            | now                                                       |
| AC-4  | §2         | the annotation carries contract identity + echo fields                                                                         | `grep -c "InjectionGateDecision.contractVersion" $BODY`                                                                          | ≥ 1                                                                                                                            | now                                                       |
| AC-5  | §3         | unflagged uses the default event                                                                                               | `grep -c "injection_screened" $BODY`                                                                                             | ≥ 1                                                                                                                            | now                                                       |
| AC-6  | §3, §5, §6 | the gate calls no router: the only `routeFrame(` text in the body is the runtime citation                                      | `grep -n "routeFrame(" $BODY \| grep -v "runtime.ts"`                                                                            | empty                                                                                                                          | now                                                       |
| AC-7  | §3         | the no-op claim is anchored to DD-1 verbatim                                                                                   | `grep -c "valid/undefined return contract is unchanged" $BODY`                                                                   | ≥ 1                                                                                                                            | now                                                       |
| AC-8  | §3, §5     | the body never says the gate drops, withholds, suppresses, quarantines or discards a frame                                     | `grep -nE "gate (drops\|withholds\|suppresses\|quarantines\|discards)" $BODY`                                                    | empty                                                                                                                          | now                                                       |
| AC-9  | §4         | comparator quoted exactly                                                                                                      | `grep -c "flagged = score === null                                                                                               |                                                                                                                                | score >= threshold" $BODY`                                | ≥ 1                                     | now |
| AC-10 | §4         | config key path exact                                                                                                          | `grep -c "session.jev.injection_threshold" $BODY`                                                                                | ≥ 1                                                                                                                            | now                                                       |
| AC-11 | §4         | equality flags; no strict-greater comparator anywhere in the body                                                              | `grep -nE "score[[:space:]]+>[[:space:]]+threshold" $BODY`                                                                       | empty                                                                                                                          | now                                                       |
| AC-12 | §4         | bounds and default stated                                                                                                      | `grep -c "z.number().gt(0).lt(1).default(0.8)" $BODY`                                                                            | ≥ 1                                                                                                                            | now                                                       |
| AC-13 | §4         | gate never reads the C1 threshold                                                                                              | `grep -nE "(reads?\|us[ei]s)[a-z]*[[:space:]]+session.jev.review_threshold" $BODY`                                               | empty                                                                                                                          | now                                                       |
| AC-14 | §5         | disposition named verbatim                                                                                                     | `grep -c "log-and-continue" $BODY`                                                                                               | ≥ 1                                                                                                                            | now                                                       |
| AC-15 | §5         | never-drop rule stated                                                                                                         | `grep -c "never drops a valid frame" $BODY`                                                                                      | ≥ 1                                                                                                                            | now                                                       |
| AC-16 | §6         | fallback event + level named                                                                                                   | `grep -c "injection_classifier_error" $BODY`                                                                                     | ≥ 1                                                                                                                            | now                                                       |
| AC-17 | §6         | DD-3 fallback triple present on one line                                                                                       | `grep -c "flagged: true, error: <string>, score: null" $BODY`                                                                    | ≥ 1                                                                                                                            | now                                                       |
| AC-18 | §6         | the shipped precedent is cited by path                                                                                         | `grep -c "src/jev/verdict-advisory.ts" $BODY`                                                                                    | ≥ 1                                                                                                                            | now                                                       |
| AC-19 | §7         | both screened payload paths present                                                                                            | `grep -c "FINAL_REPORT.payload.report" $BODY` and `grep -c "RESPONSE.payload.text" $BODY`                                        | each ≥ 1                                                                                                                       | now                                                       |
| AC-20 | §7         | non-screened direction justified for `PROMPT`                                                                                  | `grep -c "supervisor→peer" $BODY`                                                                                                | ≥ 1                                                                                                                            | now                                                       |
| AC-21 | §7         | `screenedField` name used, never a synonym                                                                                     | `grep -c "InjectionScreenInput.screenedField" $BODY`                                                                             | ≥ 1                                                                                                                            | now                                                       |
| AC-22 | §8         | both log levels named with their trigger                                                                                       | `grep -c "InjectionGateLogLevel" $BODY`                                                                                          | ≥ 1                                                                                                                            | now                                                       |
| AC-23 | §8         | null score never renders as zero                                                                                               | `grep -c "never as \`0\`" $BODY`                                                                                                 | ≥ 1                                                                                                                            | now                                                       |
| AC-24 | §0, §9     | no local schema definition introduced                                                                                          | `grep -nE "^(export )?(type\|interface)[[:space:]]" $BODY`                                                                       | empty                                                                                                                          | now                                                       |
| AC-25 | all        | only contract config keys appear                                                                                               | `grep -ohE "session\.jev\.[a-z_]+" $BODY \| sort -u`                                                                             | exactly the set `injection_check`, `injection_threshold`, `injection_timeout_ms`, `model`, `review_threshold`, `verdict_check` | now                                                       |
| AC-31 | all        | no local alias for a contract record or field                                                                                  | `grep -cE "\bInjectionDecision\b\|\bScreenResult\b\|\bGateLog\b\|injectionScore\|isFlagged\|flaggedField\|scoreThreshold" $BODY` | 0                                                                                                                              | now                                                       |
| AC-32 | §4         | the equality boundary is declared a stub-seam assertion, not an integration run                                                | `grep -c "stub" $BODY`                                                                                                           | ≥ 1                                                                                                                            | now                                                       |
| AC-33 | §4         | the strictObject integration fact is stated with its file                                                                      | `grep -c "unrecognized_keys" $BODY`                                                                                              | ≥ 1                                                                                                                            | now                                                       |
| AC-34 | §6         | a null `score` yields `flagged: true`: the bare comparator is false on null, the guarded comparator is true                    | `node -e 'console.log(JSON.stringify({bare:null>=0.8,guarded:(null===null                                                        |                                                                                                                                | null>=0.8)}))'`and`grep -c "guard is load-bearing" $BODY` | `{"bare":false,"guarded":true}` and ≥ 1 | now |
| AC-35 | §6         | the non-resolution case is first-class: trigger, contract fallback record, bound-named `error`, and the honest `0` consequence | `grep -c "unsettled" $BODY`; `grep -c "timeout after 2000 ms" $BODY`; `grep -c "restores unbounded waiting" $BODY`               | each ≥ 1                                                                                                                       | now                                                       |
| AC-36 | §2, §9     | delivery is the log/audit path, and no envelope key is introduced for it                                                       | `grep -c "Delivery path (revised for DD-2" $BODY`; `grep -nE "A2AEnvelope\.[a-z]+ =" $BODY`                                      | ≥ 1; empty                                                                                                                     | now                                                       |
| AC-37 | §4         | the third gate key is on the config surface with its bounds and default                                                        | `grep -c "session.jev.injection_timeout_ms" $BODY` and `grep -c "z.number().int().gte(0).default(2000)" $BODY`                   | each ≥ 1                                                                                                                       | now                                                       |
| AC-38 | §0         | no stale version remains: every version reference reads 1.1.0                                                                  | `grep -nE "1\.0\.0" $BODY \| grep -v "Amended"`; `grep -c "literal \`1.1.0\`" $BODY`                                             | empty; ≥ 1                                                                                                                     | now                                                       |
| AC-26 | §6         | deferred: the gate never throws out of the inbound path                                                                        | `grep -n "throw" src/jev/injection-gate.ts`                                                                                      | empty                                                                                                                          | deferred                                                  |
| AC-27 | §3, §5     | deferred: the gate has no drop/return-undefined path                                                                           | `grep -n "return undefined" src/jev/injection-gate.ts`                                                                           | empty                                                                                                                          | deferred                                                  |
| AC-28 | §4         | deferred: comparator implemented with `>=`                                                                                     | `grep -c ">= threshold" src/jev/injection-gate.ts`                                                                               | ≥ 1                                                                                                                            | deferred                                                  |
| AC-29 | §4         | deferred: threshold read from config, not hardcoded                                                                            | `grep -nE "0\.8[^0-9]" src/jev/injection-gate.ts`                                                                                | empty                                                                                                                          | deferred                                                  |
| AC-30 | §7         | deferred: only the two screened types                                                                                          | `grep -nE "\"WORK_ORDER\"\|\"HEARTBEAT\"\|\"LOCK_REQUEST\"" src/jev/injection-gate.ts`                                           | empty                                                                                                                          | deferred                                                  |

Run-contract row C2 requires `grep -c "AC-" .mypi/spec-c2-gate/spec.md` ≥ 5
[citation] `.mypi/spec-c2-gate/run-details/plan.md:70`. [exec-here] this file
satisfies it with 38 numbered checks plus their in-section references.

## §11 Gaps in the frozen contract — amendment requests (anchor: §11)

Requests only; nothing here is self-applied (§0, §9). To be relayed to
`data_contract_author` by the supervisor. Each item carries its status against
`data-contracts.md` v1.1.0 (`§Amendment 2026-10-13`,
`.mypi/spec-c2-gate/data-contracts.md:405-429`).
- **A1 — `InjectionScreenResult.error` is unbounded and unfiltered.** On a
  classifier error the string is logged at `InjectionGateLogLevel` `warn` and
  travels inside `InjectionGateDecision` (§5, §6). Provider error bodies can echo
  the submitted `content`, which would deliver peer-authored prose to the
  supervisor through a second, unscreened channel. Requested ruling: a length
  bound and "provider-authored, no `content` echo", or explicit acceptance that
  `error` is untrusted display text. [status v1.1.0: open — the amendment fixes
  derivation (`:192-205`), not length or provenance]
- **A2 — one `error` string covers four failure classes.** Rejection,
  non-number, out-of-range, and non-resolution
  (`.mypi/spec-c2-gate/data-contracts.md:113-117`) collapse into prose, so
  "provider unavailable" is not distinguishable from "provider returned garbage"
  or "call never settled" without string parsing. Requested ruling: accept
  prose-only (preferred — smallest surface) or add an enum. [status v1.1.0:
  partly answered — the derivation rule (`:195-202`) guarantees non-emptiness; the
  class discriminator is still prose-only]
- **A3 — `InjectionGateLogEntry` has no `recipient`.** `InjectionScreenInput`
  carries `recipient` (`.mypi/spec-c2-gate/data-contracts.md:98`) but §9 does not
  (`:278-288`), so a log line alone cannot establish the peer→supervisor
  direction; it must be inferred from `sender` plus `eventType`. Requested
  ruling: state that inference is sufficient, or add the field. [status v1.1.0:
  open]
- **A4 — no stated relation between `at` and `frameTimestamp`.** Both are epoch
  milliseconds (`:99`, `:278`) with no rule, so gate latency and "was the gate
  in the inbound path at all" are not derivable from the records. Requested
  ruling: `at` = gate execution time, `frameTimestamp` = envelope time, never
  compared across hosts. [status v1.1.0: open]
- **A5 — no record distinguishes `OFF` from `NOT-SCREENED` from "no inbound
  frames".** §2 makes the gate emit nothing when `injection_check` is `false`,
  and §1 of this spec inherits that silence, so an operator auditing a run cannot
  prove the gate was enabled. Requested ruling: either accept "absence means off"
  as the documented signal (this spec adopts that reading in §8) or add a
  one-per-run enable record. [status v1.1.0: open — and the timeout case widens it,
  since "gate on, seam hung" emits the same nothing as "gate off" while the frame
  is neither flagged nor delivered (§6)]

- **A6 — no stated numeric handling for the comparator.** §7 fixes
  `score >= threshold` but says nothing about rounding or representation of the
  value the seam resolved, and §4's interval is open, so the endpoints of the
  score domain (`0`, `1`) behave differently from the nearest legal thresholds.
  Requested ruling: state that the comparison is on the number as resolved (no
  epsilon, no rounding), which is how §4 of this spec behaves, and note that
  `session.jev.injection_check` is the only total off-switch. [status v1.1.0:
  answered — `.mypi/spec-c2-gate/data-contracts.md:232-239` states the boundary is
  stub-asserted with no epsilon on the parsed score, and `:226-231` states the
  off-switch rule]
- **A7 — §2 does not record that `JevSchema` is a `strictObject`.** The contract
  says the keys "live inside the existing `session.jev` block", but the shipped
  block rejects unknown keys ([exec-here] issue code `unrecognized_keys`), so the
  config surface is unreachable until the schema itself changes. Requested
  ruling: one §2 sentence saying the keys require a `JevSchema` delta, so the
  implementation plan cannot treat the gate as config-only. [status v1.1.0:
  answered — `.mypi/spec-c2-gate/data-contracts.md:68-77` states the delta, names
  `src/contracts/session-schema.ts:41-47`, and assigns the code delta to
  `implementation-plan.md`]

None of A1–A7 blocks §2–§7 as written. A6 and A7 are answered by v1.1.0; A1–A5
remain open, and A1–A5 are requests to `data_contract_author`, never edits made
here.

## §12 Falsifiers (anchor: §12)

Decision owned here: DD-2 (§5). Pre-registered before the opponent reviews.

FALSIFIER: the log-and-continue anchor is absent — neither the run plan's DD-2 row nor the Jev implementation ledger states that a flagged inbound frame is annotated and still delivered (never dropped), so DD-2 would rest on this document's own assertion alone and I would withdraw it and ask the supervisor to re-source the disposition | grep -n "log-and-continue" .mypi/spec-c2-gate/run-details/plan.md docs/jev/implementation-plan.md

## §13 Verification log (run by `spec_author` in this workspace)

- [exec-here] `grep -c "log-and-continue" .mypi/spec-c2-gate/run-details/plan.md
  docs/jev/implementation-plan.md` → `plan.md:3`,
  `docs/jev/implementation-plan.md:2` — the §12 falsifier command runs and finds
  the anchor at `plan.md:34`, `:58`, `:70` and `implementation-plan.md:82`, `:105`
  (`plan.md` renumbered when the DD-1/DD-3/DD-4 status cells were updated; the
  quote texts are unchanged).
  §14 records the same command as the DD-2 falsifier result.
- [exec-here] `grep -n "injection" src/contracts/session-schema.ts` → no output,
  exit 1 — the three §2 config keys are additions, not renames (§1).
- [exec-here] `node --input-type=module -e '…JevSchema = z.strictObject({verdict_check,
  model, review_threshold}); console.log(JevSchema.safeParse({injection_check: true,
  injection_threshold: 0.8, injection_timeout_ms: 2000}))'` → `success: false`,
  `codes: ["unrecognized_keys"]`,
  `keys: ["injection_check","injection_threshold","injection_timeout_ms"]` — the
  strictObject fact in §4 (§11 A7), checked with all three keys.
- [exec-here] `node -e 'console.log(JSON.stringify({bare:null>=0.8,
  guarded:(null===null||null>=0.8)}))'` → `{"bare":false,"guarded":true}` — the
  measurement behind §6's load-bearing-guard paragraph and AC-34.
- [exec-here] `cat -n src/jev/verdict-advisory.ts` lines 3-5, 31-32, 43-47, 51 —
  quoted in §5, §6, §9 exactly as written.
- [exec-here] `grep -n "report: z.string()\|text: z.string()"
  src/contracts/a2a-schema.ts` → `72:    text: z.string(),` and
  `121:    report: z.string(),` — §7 locators.
- [exec-here] `sed -n '569,570p' src/pi/extension.ts` →
  `  const p = reply.payload as { text?: string; report?: string };` and
  `  return p.text ?? p.report ?? "";` — the DD-2/O1 payload-prose fact (§14).
- [exec-here] `grep -n "A2AEnvelopeSchema = z.strictObject"
  src/contracts/a2a-schema.ts` → `147:export const A2AEnvelopeSchema = z.strictObject({`
  — the §2 delivery-path prohibition and §14/O1's confirming fact.
- [exec-here] `ls src/jev/` → `verdict-advisory.ts` — the gate file does not
  exist yet, so AC-26…AC-30 are recorded as deferred, not as passing.
- [exec-here] `git status --short` → `?? .mypi/spec-c2-gate/` only; no source
  file touched by this document.
- [exec-here] every now-check in §10 (AC-1…AC-25, AC-31…AC-38) was executed
  against this file with the expected result, including the negative checks
  (AC-6, AC-8, AC-11, AC-13, AC-24, AC-31, AC-36b, AC-38a) returning nothing or
  `0`. Raw output is reported to the supervisor rather than pasted here, because
  this file is the only deliverable this peer writes.
- [exec-here] `grep -c "AC-" .mypi/spec-c2-gate/spec.md` → `53`, satisfying the
  run contract's ≥ 5 (`plan.md:70`).
- [exec-here] every `path:line` locator in §0–§12 was re-resolved against the
  cited file: 85 deduplicated locators, 53 into `data-contracts.md` and 32 into
  `src/`/`docs/`, all RESOLVES within file bounds, zero DOES NOT RESOLVE. Locators
  were re-pointed from the v1.0.0 numbering to v1.1.0 in the same pass (`§2`
  config row `:48`, `§3` seam `:109`/`:113-117`, `§4` record `:129-138`, `§5`
  record `:149-160`, `§6` fallback `:168-180`, `§9` record `:262-289`, `§10`
  nullability `:305-308`).

## §14 Opposition disposition — DD-2 (anchor: §14)

Round DD-2 (`log-and-continue` is the default disposition). Opponent:
`implementation_planner`; owner: `spec_author`. Opponent result on the bus; the
run plan's round record is [citation]
`.mypi/spec-c2-gate/run-details/plan.md:139-158` (`### Round DD-2` at `:139`),
including the supervisor call at `:158` ("no blocking objection, so DD-2 stands as
claimed").

**Falsifier (§12): NOT TRIGGERED.** [exec-here] the pre-registered command, run
verbatim; the quote is trimmed mid-line with `…` where noted, and all 11 matching
lines are listed so the reader can re-run it:

```
$ grep -n "log-and-continue" .mypi/spec-c2-gate/run-details/plan.md docs/jev/implementation-plan.md
.mypi/spec-c2-gate/run-details/plan.md:34:| `docs/jev/implementation-plan.md:104-107` (I4) | `src/jev/injection-gate.ts`, log-and-continue only, opt-in default off, threshold is config not constant. |
.mypi/spec-c2-gate/run-details/plan.md:58:| DD-2 | `log-and-continue` is the default disposition: a flagged frame is still delivered, so the gate can never drop a valid frame. | `spec_author` | `implementation_planner` | CLOSED — falsifier not triggered (anchor found); no blocking objection; 1 non-blocking accepted |
.mypi/spec-c2-gate/run-details/plan.md:70:| C2 | spec.md covers every requested behaviour and acceptance check, bound to the canonical contract's exact names. … `grep -c "AC-" .mypi/spec-c2-gate/spec.md` ≥ 5 | S, V |
.mypi/spec-c2-gate/run-details/plan.md:139:### Round DD-2 — log-and-continue default (owner `spec_author`, opponent `implementation_planner`)
.mypi/spec-c2-gate/run-details/plan.md:141:FALSIFIER: the log-and-continue anchor is absent — neither the run plan's DD-2 row … | grep -n "log-and-continue" …
.mypi/spec-c2-gate/run-details/plan.md:145:FALSIFIER RESULT: the log-and-continue anchor is absent | … -> .mypi/spec-c2-gate/run-details/plan.md:34 | …
.mypi/spec-c2-gate/run-details/plan.md:152:Re-run (load-bearing exec-here): spec.md §13 claim `grep -c "log-and-continue" …`
.mypi/spec-c2-gate/run-details/plan.md:158:Supervisor call: no blocking objection, so DD-2 stands as claimed. …
.mypi/spec-c2-gate/run-details/plan.md:186:FALSIFIER RESULT: the DD-4 key or comparator is contradicted …
docs/jev/implementation-plan.md:82:      including the adopted **log-and-continue** policy: a flagged inbound frame
docs/jev/implementation-plan.md:105:      screens valid inbound frame **content**; log-and-continue only. Wire it at
```

Eleven matches, all outside this document: nine in `plan.md` (`:34`, `:58`, `:70`,
`:139`, `:141`, `:145`, `:152`, `:158`, `:186`) and two in
`docs/jev/implementation-plan.md` (`:82`, `:105`), the latter carrying the shipped
I4 policy. The DD-2 disposition therefore does not rest on my assertion alone. The
`plan.md` numbers recorded for the first execution of this command were `:33`,
`:57`, `:69`; the rows shifted by one when the DD-1/DD-3/DD-4 status cells were
updated, so the row currently at `:58` is the DD-2 row quoted above and the DD-2
queue row now reads `CLOSED — falsifier not triggered (anchor found); no blocking
objection; 1 non-blocking accepted`.

**Blocking objections: none.** The opponent filed two candidate failure modes,
both self-classified `non-blocking`, and one surviving objection (O1) that maps to
the first of them.

### CFM-1 — annotation not threaded into supervisor context → surviving O1

**Disposition: ACCEPT-and-revise.**

Failure as filed: §2 asserted the annotation is "delivered to the supervisor
context" while the supervisor prose path forwards payload prose only.
- [exec-here] `sed -n '569,570p' src/pi/extension.ts` →
  `  const p = reply.payload as { text?: string; report?: string };` /
  `  return p.text ?? p.report ?? "";` — `replyText` reads payload prose only, so
  no `InjectionGateDecision` field is reachable through it.
- [citation] `.mypi/spec-c2-gate/data-contracts.md:143-145` — "This record is the
  annotation attached to the frame and delivered to the supervisor context; the
  gate annotates, it does not alter `classifyFrame`/`routeFrame` return
  contracts". The contract states the record's role and names no transport; §2
  had supplied one that the code does not have.
- [exec-here] the opponent's confirming command
  `grep -n "delivered to the supervisor context" .mypi/spec-c2-gate/spec.md .mypi/spec-c2-gate/data-contracts.md`
  → `spec.md:119:attached to the frame and delivered to the supervisor context; the gate`
  and
  `data-contracts.md:144:delivered to the supervisor context; the gate annotates, it does not alter`.
  Both hits sit in the quoted contract sentence, which the revision now
  immediately qualifies.
- [reasoned] the revision is the opponent's smallest fix, not a defence: the
  filed failure reproduces by measurement, so no rebuttal is offered.

Applied in place, §2 ("**Delivery path (revised for DD-2, §14/O1)**"): delivery is
satisfied by the `InjectionGateLogEntry` log/audit path appended to
`conversation.jsonl`; threading the record into a later supervisor prompt is
transport plumbing owned by `implementation-plan.md`, and that plumbing must NOT
modify `A2AEnvelopeSchema` nor add a key to `A2AEnvelope`. Locked by AC-36.

### CFM-2 — envelope attachment would violate the wire schema

**Disposition: REJECT-with-reason as an objection; ACCEPT as a constraint.**

Reason for rejection: the opponent's own classification is `non-blocking` for
DD-2, and no section of this document claims an envelope field for the annotation,
so there is nothing to withdraw. Evidence: [exec-here]
`sed -n '1,/^## §10 Acceptance checks/p' .mypi/spec-c2-gate/spec.md | grep -n "A2AEnvelope"`
→ 9 hits, all of them either the `A2AEnvelope.type` reading (§1, §2, §7), the
`z.strictObject` citation (§2, §7), or the §7 list of envelope metadata that is
not screened; none adds or reads a field carrying the annotation. The constraint
is still accepted, because it is now load-bearing for the accepted revision:
[exec-here]
`grep -n "A2AEnvelopeSchema = z.strictObject" src/contracts/a2a-schema.ts` →
`147:export const A2AEnvelopeSchema = z.strictObject({`, so a key attached to the
envelope is rejected as `unrecognized_keys` rather than carried. The revision
states the prohibition in words and AC-36's negative half
(`grep -nE "A2AEnvelope\.[a-z]+ =" $BODY` → empty) keeps it true.

**Net effect.** One surviving objection, accepted and applied as a wording
revision; DD-2's substance — annotate, deliver, never drop — is unchanged, and no
acceptance check was weakened or removed. AC-1…AC-33 stand; AC-34…AC-38 were added
(§10) for the v1.1.0 alignment and this revision. Residual risk, stated plainly:
log-and-continue plus log/audit-path delivery means the flag is advisory and the
unflagged state is probabilistic, so nothing here stops an injected instruction
from reaching the supervisor's context — matching the supervisor's own note at
[citation] `.mypi/spec-c2-gate/run-details/plan.md:158`.
