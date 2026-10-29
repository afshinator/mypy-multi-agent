<!-- v1.0 -->
# Telemetry correlation handoff

> **Decision record — authoritative.** Status of the standing OpenTelemetry SDK:
> **not approved.** OTel-compatible tracing (the data model and conventions) **is**
> approved. The SDK as a standing runtime dependency is adopted only if a bounded Bun
> experiment earns it (D4–D6).
>
> The #21 turn-pairing fix is in place: `turnDurations` pairs by identity. The tracing
> work this record gated has shipped: D6 selected fields-only, S6 built it in
> `src/tracing/`, D3 put `traceparent` on the strict-Zod envelope
> (`contracts/a2a-schema.ts:157`), and V4 was confirmed before that field was added. §B
> holds the background and rationale.

## Decision (D1–D7)

**D1 — Adopt the OTel trace data model and conventions.** `trace_id`, `span_id`,
`parent_span_id`, the W3C `traceparent` format, GenAI attribute names where they map
cleanly, and span links for cross-branch causal edges that should not be modeled as
parenthood (not for every concurrent span — concurrent children under one parent are
fine). This is settled and does not depend on the experiment.

**D2 — Exclude from scope.** No metrics signal, no mandatory collector or backend, no
network egress, no replacement of the existing JSONL. OTel observes. It is not the state
store and not an accounting authority.

**D3 — Cross-process propagation is manual either way, and preserves existing
correlation.** Write explicit inject/extract on the A2A envelope regardless of outcome.
The SDK path uses OTel's standard propagator. The fields-only path uses a minimal W3C
`traceparent` implementation. In both, `traceparent` **supplements** the existing
`correlationId` and must preserve current A2A correlation and routing semantics. It does
not replace application message identity. Because the bus validates strictly, envelope
changes update the Zod event schemas (§B.7 V4). D3 is required in both worlds, so it is
not part of what the experiment decides.

**D4 — Run one focused Bun experiment, three separately reported results.**
- (a) in-process active-context survival across the supervisor's `dispatchChains` promise hops;
- (b) cross-process inject/extract across the socket;
- (c) concurrent isolation: dispatch work orders A and B concurrently, overlap their responses through `dispatchChains`, confirm no A operation inherits B's context or the reverse.

**D5 — Correctness is a pass/fail gate, not a comparison axis.** Both approaches must
satisfy identical correctness requirements before any cost comparison. Verify against an
**expected execution graph defined independently of the tracing implementation** — if the
oracle is derived from OTel's own output, the test validates its own assumptions. The
graph first classifies each span as run-level or work-order-level, then asserts:
- every work-order-scoped span belongs to its expected work order; run-level spans (e.g. `run`, `finalize`) are validated against their expected run and parent context;
- every span has its expected parent or span link;
- no context crosses between concurrent work orders;
- every completed span has a matching start and end.

A passing SDK test makes the SDK **eligible**, not selected.

**D6 — Selection, only after both pass D5.** Compare implementation and maintenance
complexity and runtime overhead. **Default to fields-only.** Adopt the SDK only if it
delivers a meaningful reduction in complexity without unacceptable overhead. Stopping
rule: if fields-only begins recreating an async context-management framework, stop that
path and reassess the SDK, selecting it only if it also passes the D5 gate and meets D6.
Otherwise retain explicit propagation or narrow scope.

> **D6 resolved — fields-only selected.** Both implementations passed D5 (oracle A1–A10,
> real cross-process) and the overhead comparison was judged negligible, so the locked
> tie-break applies. The per-span figures quoted when this was settled have no committed
> benchmark behind them: `docs/evidence/s4-bun-context-2026-10-19.md` records the
> comparison as "not done" and no measurement script exists, so treat them as
> unrecorded. The SDK's only meaningful
> complexity reduction — automatic `trace_id`/parent inheritance — was the one bug class
> fields-only hit and fixed with a single field (`extract` returns the trace id,
> `startSpan` inherits it); against that it adds four dependencies, a Bun-version-pinned
> `AsyncLocalStorage`, the `oracle.*` attribute plumbing, and ~3.3× span memory. The
> stopping rule did not trigger: fields-only's manual propagation stays bounded at eight
> span names and one cross-process edge; the escalation point is a growing span surface
> (links, baggage, sampling). One fix folded into S6: map `endSpan` by span id so the
> O(n) scan becomes O(1).

**D7 — Fix #21 independently of D1–D6.** Pair scorecard turns on a **unique turn id**
from existing application identity. Not `trace_id` (groups a whole run) and not
`work_order_id` (one work order holds multiple turns, so pairing on it reproduces the
same mispairing inside a work order). Confirm a unique turn id exists in the current
event schema; if it does not, minting one is part of this fix (§B.7 V2/V4). Ships without
waiting on the Bun experiment.

## Decision procedure (A1–A5)

The order is the point: establish correctness independently, test under real concurrency,
hold both approaches to the same gate, compare cost only after, default to the lighter
dependency.

**A1.** Establish independently verifiable correctness (the D5 expected execution graph).
**A2.** Test Bun async-context behavior under actual concurrency (D4a, D4c).
**A3.** Require both approaches to satisfy identical correctness requirements (D5 gate).
**A4.** Compare implementation and maintenance complexity and overhead only after A3 (D6).
**A5.** Default to fields-only unless the SDK demonstrates a meaningful advantage.

Identifier roles, kept distinct (D3/D7 depend on not conflating them):

| Identifier       | Purpose                                              |
| ---------------- | ---------------------------------------------------- |
| `trace_id`       | groups all spans in one run                          |
| `span_id`        | identifies one operation                             |
| `parent_span_id` | establishes execution hierarchy                      |
| `work_order_id`  | identifies the application work assignment           |
| `correlationId`  | connects application messages and responses          |
| turn id          | identifies one peer turn — the key #21 pairs on (D7) |

---

# §B Background and rationale

Technical background for the decisions above: the current telemetry, how turn pairing
works and why it pairs by identity, the OTel data model, the options considered, the code
facts, and the remaining tracing work.

## B.1. In one line

Use OTel-compatible trace identifiers for cross-process execution correlation. Separately,
#21 is handled by pairing turn opens and closes on existing application ids
(`correlationId`, `taskId`), not by timestamp order. No collector, no daemon, no network
egress. _(SDK: conditional, see D4–D6.)_

This is option **O2** from the OpenTelemetry evaluation. §B.6 covers why not the heavier
options.

## B.2. The current telemetry (what you have today)

| Stream               | Written by                                                         | Contents                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation.jsonl` | `Runtime.log()`                                                    | bus frames: register, prompt, response, final_report, intent_to_modify, crash/stall/unusable events. `HEARTBEAT` deliberately excluded. Entries carry `correlationId` (PROMPT/RESPONSE) and `taskId` (FINAL_REPORT) |
| `tool-calls.jsonl`   | `toolCallLogger`                                                   | one record per peer tool execution: name, args, result                                                                                                                                                              |
| `scorecard.json`     | `scorecard/` (~973 LOC), written by default via `record_scorecard` | per-run health computed at finalize: outcome vs exit code, turn durations, tool time, retries, crashes, mistake classes                                                                                             |

Two properties that matter for this proposal:
1. The JSONL is append-only, local, greppable, and diffable. It is the persistent event
   history and the asset this proposal builds on. Resumable runtime state lives separately
   in `run-state.json`. The filesystem holds both, with no database and no daemon.
2. The scorecard is derived. It reads the JSONL after the run and computes metrics.
   It never changes the exit code. A broken scorecard metric is a measurement bug,
   not a run-correctness bug.

## B.3. Why turn pairing is by identity (#21)

`turnDurations` (`shared/turn.ts`, imported by `src/scorecard/scorecard.ts`) pairs turn
opens and closes by identity:
`correlationId` for PROMPT/RESPONSE, `taskId` for WORK_ORDER/FINAL_REPORT. Id-less entries
are skipped, not mispaired.

The failure this avoids is a timestamp-order zip. Pairing is scoped per peer (opens keyed
by recipient, closes by sender), so interleaving across peers is already separated. The
mispairing occurs within a single peer, when that peer's turns complete out of order.

**Hypothetical mispairing under concurrent turns.** If a peer had a work order in flight
and also received a peer-to-peer prompt while working, and it answered the prompt before
finishing the work order:

```
WORK_ORDER   t1 opens  t=0   (taskId t1)
PROMPT       p1 opens  t=1   (correlationId p1)
RESPONSE     p1 closes t=3   (p1 ran 2s)
FINAL_REPORT t1 closes t=5   (t1 ran 5s)
```

A per-peer timestamp zip pairs opens `[WORK_ORDER@0, PROMPT@1]` with closes
`[RESPONSE@3, FINAL_REPORT@5]`:

```
pair 1: WORK_ORDER@0 with RESPONSE@3     -> reports 3s  (t1 actually ran 5s)
pair 2: PROMPT@1     with FINAL_REPORT@5 -> reports 4s  (p1 actually ran 2s)
```

Both wrong. By identity the attribution is t1=5s, p1=2s. Two concurrent prompts to the
same peer completing out of order are the same failure. This mispairing is latent, not
reachable today: `PeerSession.runTurn` serializes turns on a promise queue, so a peer never
runs two turns concurrently and never completes them out of order — a prompt received
mid-order is queued behind the work order and answered after it. The bug becomes live only
if a peer ever runs concurrent turns (e.g. fan-out or in-process peers).

**Where the ids come from.** The turn id already exists on the wire. `correlationId` is
minted as `prompt-${seq}` by `PeerMessaging.sendPrompt` and echoed by the peer on RESPONSE.
`taskId` lives in the WORK_ORDER payload; FINAL_REPORT does not carry it, so `Runtime.log`
stamps it onto FINAL_REPORT entries from `inFlightTaskIds`. `Runtime.log` also persists
`correlationId` into `conversation.jsonl`. Pairing reuses these existing ids; no new id is
minted and no tracing infrastructure is added.

## B.4. The OpenTelemetry idea worth borrowing (plain terms)

OTel's entire conceptual payload for this problem is three ids and a parent link. You
do not need the SDK to use the idea.

| OTel term               | Plain meaning                                             | In this system                                                  |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| **trace**               | one end-to-end operation                                  | one `/mypi-multi-agent` run                                     |
| **span**                | one timed unit of work (has start + end)                  | a dispatch, a peer turn, a tool call, a validation command      |
| **trace_id**            | id shared by everything in the run                        | constant per run                                                |
| **span_id**             | id unique to one span                                     | one per open/close pair                                         |
| **parent_span_id**      | the enclosing span's id                                   | links a tool call to its peer turn, a peer turn to its dispatch |
| **context propagation** | parent ids travel with the work across process boundaries | parent id rides the `PROMPT` frame from supervisor to peer      |

Spans nest into a tree. That tree is exactly your run lifecycle:

Every node carries the same `trace_id` and its own `span_id`. A `parent` is always a
`span_id`, never the `trace_id`. The root span's parent is null. Labels below are
illustrative, not valid encoded OTel ids.

```
run              trace_id=T  span=r1  parent=null
├─ dispatch      trace_id=T  span=d1  parent=r1
│  ├─ peer.turn  trace_id=T  span=p1  parent=d1
│  │  ├─ tool.read    span=k1  parent=p1
│  │  ├─ tool.edit    span=k2  parent=p1
│  │  └─ model.call   span=m1  parent=p1   (retries = sibling spans under p1)
│  └─ final_report    span=f1  parent=d1
└─ finalize      trace_id=T  span=z1  parent=r1
   └─ validation.command  span=v1  parent=z1
```

This tree is the clean case. Concurrency alone does not need links — concurrent children
under one parent are legitimate. A span link is for an _additional_ causal edge that
should not be modeled as parenthood, e.g. an `await_response` that unblocks on another
agent's event: that event affects the waiter but is not its parent. Use links only there.

Once every event carries `span_id` and `parent_span_id`, turn duration is
`end_time - start_time` for one `span_id`. Interleaving across agents becomes
irrelevant, because you look up by id, never by position.

## B.5. The change set (O2)

The scorecard pairing is in place (below). Both tracing pieces this option names — the
span envelope and parent-id propagation — are shipped (§B.8).

### Add a span envelope to logged events

Add these fields to the relevant JSONL records (dispatch, peer turn boundaries, tool
calls, validation commands):

| Field                     | Meaning                                                                    | Source                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trace_id`                | per-run id                                                                 | a random, nonzero, OTel-compatible 16-byte id (32 lowercase hex). Never derived from task name or timestamp. A UUIDv4's 128 bits reformatted to 32 hex is acceptable |
| `span_id`                 | per-span id                                                                | a freshly generated valid OTel id (8 bytes, 16 hex). Never aliased onto `correlationId` or the turn id — different formats and purposes                              |
| `parent_span_id`          | enclosing span, `null` at root                                             | read from the inbound frame, or the current turn's `span_id` for tool calls                                                                                          |
| `name`                    | span name, e.g. `dispatch`, `peer.turn`, `tool.edit`, `validation.command` | the emitter                                                                                                                                                          |
| `start_time` / `end_time` | span bounds                                                                | emit a start record and a close record sharing `span_id`, or one record with both                                                                                    |
| `attributes`              | optional bag: model, work_order_id, tool name, exit                        | the emitter                                                                                                                                                          |

`agent_id` is already present on frames and stays as-is.

Field names follow OTel's wire shape deliberately. A later export to OTLP becomes a
serialization pass, not a re-instrumentation. That only holds if the ids are valid OTel
ids. Reusing a UUID `correlationId` as a `span_id` would force a remap at export and
breaks the claim.

### Propagate parent id over the existing `PROMPT` frame

No new transport. The supervisor mints the dispatch `span_id` when it sends `PROMPT`
and includes it in the frame. The peer reads it as its `parent_span_id`, mints its own
`span_id` per turn and per tool call, and writes them into `tool-calls.jsonl`. _(D3
refines: `traceparent` supplements `correlationId`, it does not replace it.)_

### Scorecard duration pairing

`turnDurations` groups by id: `correlationId` for PROMPT/RESPONSE, `taskId` for
WORK_ORDER/FINAL_REPORT. Each close matches the open with the same id; id-less entries are
skipped. Immune to interleaving. This is the #21 fix and needs nothing further.

**Scope boundary.** Additive only. Does not refactor `logging/`, does not add a backend,
does not add a new transport, does not touch the exit-code path. The scorecard stays
advisory.

## B.6. Why not the heavier options

| Option | What it is                                     | Assessment                                                                   |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| O1     | fix #21 alone, no span model                   | the identity-pairing fix; in place                                           |
| O2     | borrow the 3-id data model into existing JSONL | the fields-only tracing path (D6); both portions shipped                     |
| O3     | full OTel SDK, local file export               | adds a dependency to emit JSON already written locally; conditional on D4–D6 |
| O4     | full OTel SDK + collector/backend              | reverses the no-daemon / no-egress architecture; rejected (D2)               |

**R1** OTel's backend ecosystem (collector, OTLP endpoint, Jaeger/Tempo/Grafana) needs a
daemon or network egress. The architecture handoff §6 decided the opposite. O4 re-litigates
that; D1–D7 do not.

**R2** The standing-SDK-with-export-off concern: it pays the SDK's weight to produce JSON
the local writer already produces. The SDK's one standing benefit, automatic cross-async
parenting, is also its biggest Bun risk, so D4–D6 decide it by test rather than assumption.

## B.7. Code facts (V1–V5)

The checks behind the above, answered against the code. The pointers remain useful for
code readers.

| #   | Item                                                                                                 | Answer                                                                                                                                                                                                                                                | Where to look                                                           |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| V1  | Correlation id on `PROMPT`/`RESPONSE` frames, and whether it reaches `tool-calls.jsonl`              | `correlationId` is envelope-level (`A2AEnvelopeSchema`), not on the PROMPT/RESPONSE payloads, and never reached `tool-calls.jsonl`. `Runtime.log` persists it into `conversation.jsonl`                                                               | `bus/`, `logging/`, `contracts/` A2A catalogue                          |
| V2  | The function that computes turn durations, and the turn id it pairs on                               | `turnDurations`. `correlationId` (`prompt-${seq}` from `PeerMessaging.sendPrompt`) and `taskId` (WORK_ORDER payload) are the ids; FINAL_REPORT does not echo `taskId`, so `Runtime.log` stamps it from `inFlightTaskIds`                              | `scorecard/`                                                            |
| V3  | Whether turn open/close are discrete events or derived                                               | Derived for turns. No turn open/close records; `turnDurations` infers open from WORK_ORDER/PROMPT and close from FINAL_REPORT/RESPONSE. "Add id to existing events" was the right branch; S6 later added `spans.jsonl` as a second, span-level record | `scorecard/`, `logging/`, `tracing/`                                    |
| V4  | Event schemas are strict Zod                                                                         | Confirmed. `A2AEnvelopeSchema` and the payload schemas are `z.strictObject`; the bus rejects unknown keys. Any new frame field needs a schema update                                                                                                  | `contracts/session-schema.ts` and the A2A event schemas in `contracts/` |
| V5  | Whether the supervisor can attach a field to the outbound `PROMPT` frame without a tool-layer change | Yes. `PeerMessaging.sendPrompt` builds the envelope directly; the pi `send_prompt` tool calls into it                                                                                                                                                 | `pi/`, `runtime/` dispatch path                                         |

V4 was the gate for the span envelope: the system rejects unknown keys by design, so the
field had to be added to the event contract, and it is there (`a2a-schema.ts:157`). Any
further span field needs the same schema update.

## B.8. Tracing work — status

The #21 pairing fix and the V1–V5 code checks are in place (§B.3, §B.7), and the
`S3`–`S6` sequence is complete (`A1`–`A5` belong to the decision procedure):

**S3. Shipped.** Trace semantics and the A1–A10 oracle: `docs/trace-semantics-oracle.md`,
graded against the production tracer by `test/unit/tracing-oracle.test.ts`.
**S4. Shipped.** Throwaway SDK and fields-only prototypes: `scripts/bun-s4-probe/`, re-run
at `713aec4` — 17 spans per strategy, propagation 3/3, mutation test 18/18, two-process
run clean.
**S5. Shipped.** The D5 gate was applied to both approaches; D6 selected fields-only
(D6 note above).
**S6. Shipped.** `src/tracing/` plus production A2A propagation (D3): `traceparent` on
`WORK_ORDER`/`PROMPT`, spans appended to `run-details/spans.jsonl` by the supervisor and
every peer.

D3 and S6 are consistent: manual propagation was unavoidable in both worlds (D3), and the
shipped implementation uses a minimal `traceparent` rather than OTel's propagator, per the
D6 selection.
