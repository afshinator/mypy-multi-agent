# Telemetry correlation handoff

> **Decision record — 2026-10-19. This section is authoritative and supersedes the
> original proposal kept as background below (§B).** Status of the standing OpenTelemetry
> SDK: **not approved.** OTel-compatible tracing (the data model and conventions) **is**
> approved. Any earlier recommendation — in the uploaded adoption case or in §B's flat
> "no SDK" framing — is superseded by the conditional in D4–D6: the SDK as a standing
> runtime dependency is adopted only if a bounded Bun experiment earns it.
>
> Verified against the two handoff docs, not `src/`. The `V1`–`V5` checks in §B.7 still
> gate implementation. The code is the truth.

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

**D7 — Fix #21 independently of D1–D6.** Pair scorecard turns on a **unique turn id**
from existing application identity. Not `trace_id` (groups a whole run) and not
`work_order_id` (one work order holds multiple turns, so pairing on it reproduces the
same mispairing inside a work order). Confirm a unique turn id exists in the current
event schema; if it does not, minting one is part of this fix (§B.7 V2/V4). Ships without
waiting on the Bun experiment.

> **D7 shipped.** The turn id already existed on the wire — `correlationId` for
> PROMPT/RESPONSE and `taskId` for WORK_ORDER/FINAL_REPORT — but `Runtime.log()`
> dropped `correlationId` and FINAL_REPORT never echoed `taskId`. The fix persists
> both into `conversation.jsonl` and pairs `turnDurations` by identity with no
> timestamp fallback (id-less entries are skipped, not mispaired).

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

| Identifier | Purpose |
|---|---|
| `trace_id` | groups all spans in one run |
| `span_id` | identifies one operation |
| `parent_span_id` | establishes execution hierarchy |
| `work_order_id` | identifies the application work assignment |
| `correlationId` | connects application messages and responses |
| turn id | identifies one peer turn — the key #21 pairs on (D7) |

---

# §B Background — original proposal (superseded by the decision record above)

Kept for reasoning and evidence. Where §B.1 and §B.6 reject the SDK outright, that flat
rejection is **superseded** by D4–D6: the SDK is conditional, not foreclosed. Everything
else below — the #21 mechanics, the current-telemetry map, and the `V1`–`V5` checks —
stands.

## B.1. What this proposes, in one line

Adopt OTel-compatible trace identifiers for cross-process execution correlation.
**Separately**, fix #21 by pairing turn-open and turn-close events on a unique application
turn id (D7). These are two changes with separate acceptance criteria, not one. No
collector, no daemon, no network egress. *(SDK: conditional, see D4–D6.)*

This is option **O2** from the OpenTelemetry evaluation. §B.6 explains the original
reasoning against the heavier options.

## B.2. The current telemetry (what you have today)

| Stream | Written by | Contents |
|---|---|---|
| `conversation.jsonl` | `logging/` (~40 LOC) | bus frames: register, prompt, response, final_report, intent_to_modify, crash/stall/unusable events. `HEARTBEAT` deliberately excluded |
| `tool-calls.jsonl` | `logging/` | one record per peer tool execution: name, args, result |
| `scorecard.json` | `scorecard/` (~1021 LOC), opt-in via `record_scorecard` | per-run health computed at finalize: outcome vs exit code, turn durations, tool time, retries, crashes, mistake classes |

Two properties that matter for this proposal:

1. The JSONL is append-only, local, greppable, and diffable. It is the persistent event
   history and the asset this proposal builds on. Resumable runtime state lives separately
   in `run-state.json`. The filesystem holds both, with no database and no daemon.
2. The scorecard is derived. It reads the JSONL after the run and computes metrics.
   It never changes the exit code. A broken scorecard metric is a measurement bug,
   not a run-correctness bug.

## B.3. The defect this fixes (#21)

**Symptom:** `scorecard.json` turn durations are wrong whenever peer turns overlap.

**Cause:** the scorecard pairs turn-open events with turn-close events in **timestamp
order** rather than by the id that ties a specific open to its own close. The system
runs N peers in parallel, so turns overlap constantly. Order-pairing mismatches them.

**Concrete mispairing.** Two peers, A and B.

```
A opens  t=0
B opens  t=1
B closes t=3     (B ran 2s)
A closes t=5     (A ran 5s)
```

Order-pairing zips opens `[A@0, B@1]` against closes sorted by time `[B@3, A@5]`:

```
pair 1: A@0 with B@3  -> reports 3s   (A actually ran 5s)
pair 2: B@1 with A@5  -> reports 4s   (B actually ran 2s)
```

Both durations are wrong, and the error grows with concurrency and nesting. This is
the normal operating mode of a multi-agent orchestrator, so the metric is wrong in
the common case, not an edge case.

**What this needs to fix.** Bus frames carry correlation ids (the mechanism behind
`send_prompt`/`await_response` pairing and the `correlation-timeout` log), which proves
message-level correlation is available. It does not prove a correlation id uniquely
identifies one peer turn — a work order holds multiple turns, so a work-order-level id
cannot pair them. S1 must verify whether a suitable unique turn id already exists. If not,
D7 introduces one independently of tracing. No new tracing infrastructure either way.

## B.4. The OpenTelemetry idea worth borrowing (plain terms)

OTel's entire conceptual payload for this problem is three ids and a parent link. You
do not need the SDK to use the idea.

| OTel term | Plain meaning | In this system |
|---|---|---|
| **trace** | one end-to-end operation | one `/mypi-multi-agent` run |
| **span** | one timed unit of work (has start + end) | a dispatch, a peer turn, a tool call, a validation command |
| **trace_id** | id shared by everything in the run | constant per run |
| **span_id** | id unique to one span | one per open/close pair |
| **parent_span_id** | the enclosing span's id | links a tool call to its peer turn, a peer turn to its dispatch |
| **context propagation** | parent ids travel with the work across process boundaries | parent id rides the `PROMPT` frame from supervisor to peer |

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
under one parent are legitimate. A span link is for an *additional* causal edge that
should not be modeled as parenthood, e.g. an `await_response` that unblocks on another
agent's event: that event affects the waiter but is not its parent. Use links only there.

Once every event carries `span_id` and `parent_span_id`, turn duration is
`end_time - start_time` for one `span_id`. Interleaving across agents becomes
irrelevant, because you look up by id, never by position.

## B.5. The change set (O2)

Three edits. All additive to what exists.

### Add a span envelope to logged events

Add these fields to the relevant JSONL records (dispatch, peer turn boundaries, tool
calls, validation commands):

| Field | Meaning | Source |
|---|---|---|
| `trace_id` | per-run id | a random, nonzero, OTel-compatible 16-byte id (32 lowercase hex). Never derived from task name or timestamp. A UUIDv4's 128 bits reformatted to 32 hex is acceptable |
| `span_id` | per-span id | a freshly generated valid OTel id (8 bytes, 16 hex). Never aliased onto `correlationId` or the turn id — different formats and purposes |
| `parent_span_id` | enclosing span, `null` at root | read from the inbound frame, or the current turn's `span_id` for tool calls |
| `name` | span name, e.g. `dispatch`, `peer.turn`, `tool.edit`, `validation.command` | the emitter |
| `start_time` / `end_time` | span bounds | emit a start record and a close record sharing `span_id`, or one record with both |
| `attributes` | optional bag: model, work_order_id, tool name, exit | the emitter |

`agent_id` is already present on frames and stays as-is.

Field names follow OTel's wire shape deliberately. A later export to OTLP becomes a
serialization pass, not a re-instrumentation. That only holds if the ids are valid OTel
ids. Reusing a UUID `correlationId` as a `span_id` would force a remap at export and
breaks the claim.

### Propagate parent id over the existing `PROMPT` frame

No new transport. The supervisor mints the dispatch `span_id` when it sends `PROMPT`
and includes it in the frame. The peer reads it as its `parent_span_id`, mints its own
`span_id` per turn and per tool call, and writes them into `tool-calls.jsonl`. *(D3
refines: `traceparent` supplements `correlationId`, it does not replace it.)*

### Rewrite the scorecard duration pairing

Replace the timestamp-order pairing with a group-by-id lookup: match each close to the
open with the same unique turn id, subtract, done. Immune to interleaving. This is the
direct #21 fix (D7).

**Scope boundary.** Additive only. Does not refactor `logging/`, does not add a backend,
does not add a new transport, does not touch the exit-code path. The scorecard stays
advisory.

## B.6. Original reasoning against the heavier options *(SDK verdict superseded by D4–D6)*

| Option | What it is | Original verdict | Status now |
|---|---|---|---|
| O1 | fix #21 alone, no span model | correct but leaves nested-timing value on the table | still valid |
| O2 | borrow the 3-id data model into existing JSONL | recommended | the fields-only path in D6 |
| O3 | full OTel SDK, local file export | overkill, adds a dependency to emit JSON you already emit | **superseded** — now conditional on D4–D6 |
| O4 | full OTel SDK + collector/backend | reverses the no-daemon / no-egress architecture | still rejected (D2) |

**R1** OTel's backend ecosystem (collector, OTLP endpoint, Jaeger/Tempo/Grafana) needs
a daemon or network egress. The architecture handoff §6 decided the opposite. O4
re-litigates that. D1–D7 do not.

**R2** The standing-SDK-with-export-off case was the original objection: it pays the
SDK's weight to produce JSON the 40-LOC writer already produces locally. D4–D6 replace
that flat objection with a test — the SDK's one standing benefit (automatic
cross-async parenting) is also its biggest Bun risk, so the experiment decides it rather
than an assumption.

## B.7. Verify against code before implementing

Confirm each before coding.

| # | Item | Where to look |
|---|---|---|
| V1 | Exact correlation-id field on `PROMPT`/`RESPONSE` frames, and whether it already reaches `tool-calls.jsonl` | `bus/`, `logging/`, `contracts/` A2A catalogue |
| V2 | The scorecard function that computes turn durations, and whether a unique turn id already exists to pair on | `scorecard/` |
| V3 | Whether turn-open/turn-close are discrete logged events or derived, which decides "add id to existing events" vs "add a `spans.jsonl`" | `scorecard/`, `logging/` |
| V4 | Event schemas are strict Zod. Adding frame fields means updating the A2A event schema or strict parsing rejects the unknown keys | `contracts/session-schema.ts` and the A2A event schemas in `contracts/` |
| V5 | Whether the supervisor can attach a field to the outbound `PROMPT` frame without a tool-layer change | `pi/`, `runtime/` dispatch path |

V4 is the sharpest integration constraint. The system rejects unknown keys by design,
so the span fields must be added to the event contract, not just emitted.

## B.8. Implementation sequence

Ordered so nothing commits to the fields-only implementation before the experiment that
decides it. (This corrects an earlier draft that built the span envelope before the
experiment.) Codes are `S1`–`S6` to avoid colliding with the `A1`–`A5` decision procedure.

**S1.** Verify V1–V5 against `src/`.
**S2.** Fix #21 independently (D7): pair turns on a unique turn id. No tracing dependency; ships on its own and does not wait on S3–S6.
**S3.** Define trace semantics and the independent correctness oracle (the D5 expected execution graph).
**S4.** Build throwaway SDK and fields-only prototypes against the same scenarios (D4 a/b/c).
**S5.** Apply the D5 correctness gate, then the D6 selection.
**S6.** Implement the selected approach and its production A2A propagation (D3).

D3 and S6 are consistent: manual propagation is unavoidable in both worlds (D3), but which
implementation ships — OTel's standard propagator or a minimal `traceparent` — is decided
at S5 and built at S6. S4's prototypes use throwaway inject/extract only.
