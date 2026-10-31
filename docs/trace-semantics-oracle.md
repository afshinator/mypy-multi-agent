# Trace semantics and the expected-execution-graph oracle (S3)

> S3 deliverable. This is a specification, not instrumentation. No production code
> changes. No SDK-vs-fields decision is made here — that happens at S5, only after both
> prototypes pass the D5 gate defined below. Anchors name symbols, never line numbers.
> Source of truth: `docs/temp-handoffs/telemetry-correlation-handoff.md` D1–D7, A1–A5.

## 1. What this defines

Two things:
1. **Trace semantics** — the span taxonomy, fields, parent rules, and cross-process
   propagation contract both implementations must produce.
2. **The expected-execution-graph oracle** — the D5 gate: structural assertions, defined
   independently of any tracing implementation, that grade an SDK prototype and a
   fields-only prototype identically.

The oracle does not know how a span was produced (OTel SDK vs hand-threaded fields). It
reads a normalized `SpanRecord` set plus independently recorded application facts, and
checks graph structure and coverage.

## 2. Span record (normalized)

Both prototypes emit spans in this shape (or are normalized to it). The oracle grades only
this shape.

```ts
interface SpanRecord {
  trace_id: string; // 32 lowercase hex, one per run
  span_id: string; // 16 lowercase hex, unique within the trace
  parent_span_id: string | null; // null at the root
  name: SpanName; // see taxonomy
  kind: "run-level" | "work-order-level";
  scope_id: string | null; // taskId (work-order path) or correlationId (prompt path); null for run-level
  agent_id: string | null; // peer id for peer-side spans; null for supervisor-side
  start_time: number; // epoch ms
  end_time: number | null; // null while open
  status: "ok" | "error" | "aborted";
  links: Array<{ span_id: string; reason: string }>; // cross-branch causal edges, never parenthood
  operation_id?: string; // REQUIRED for operational span names; absent on run/turn spans (see §4.1, A10)
  attributes?: Record<string, unknown>; // model, tool name, exit code, ...
}

type SpanName =
  | "run"
  | "finalize"
  | "validation.command" // run-level
  | "dispatch"
  | "peer.turn"
  | "tool"
  | "final_report" // work-order path
  | "prompt"; // prompt path
```

`scope_id` is the independent ground-truth key the oracle asserts against. It is the
application identity that already exists — `taskId` (WORK_ORDER payload) and `correlationId`
(`prompt-${seq}` from `PeerMessaging.sendPrompt`) — never a value derived from the tracing
implementation.

## 3. Trace semantics

### 3.1 A trace is one run

`trace_id` is minted once when `startRun` begins and is constant for the whole run. The
root span is `run` with `parent_span_id = null`.

Resume (#17) is deferred. Resumed runs are **excluded from the initial D5 gate** (S4). The
default intent is that a resumed run continues the same `trace_id` (the `run-state.json`
snapshot persists it), but whether the `run` span is reopened or re-minted is an
SDK-lifecycle question not decided here. Resolve it only if and when a resumed run must be
tested.

### 3.2 Taxonomy (authoritative name → kind map)

This table is the single authority for the name→kind mapping. A prototype may not define
its own.

| name                 | minted by (process)                                  | parent                                    | scope_id                | kind             |
| -------------------- | ---------------------------------------------------- | ----------------------------------------- | ----------------------- | ---------------- |
| `run`                | supervisor                                           | null                                      | null                    | run-level        |
| `dispatch`           | supervisor (`Runtime.dispatch` → WORK_ORDER emit)    | `run`                                     | taskId                  | work-order-level |
| `peer.turn`          | peer (one per turn, `turn_start`→`turn_end`)         | `dispatch` or `prompt`, **cross-process** | taskId or correlationId | work-order-level |
| `tool`               | peer (`tool_execution_start`→`tool_execution_end`)   | enclosing `peer.turn`                     | enclosing turn's scope  | work-order-level |
| `final_report`       | supervisor (on FINAL_REPORT receipt)                 | `dispatch`                                | taskId                  | work-order-level |
| `prompt`             | sender (supervisor; peer-origin deferred, see below) | sender's current span                     | correlationId           | work-order-level |
| `finalize`           | supervisor (`Runtime.finalize`)                      | `run`                                     | null                    | run-level        |
| `validation.command` | supervisor (`runValidation` per configured command)  | `finalize`                                | null                    | run-level        |

Notes:
- **`final_report` is supervisor-minted** (in-process parent), so the only cross-process
  parent edge is `dispatch`/`prompt` → `peer.turn`. For the supervisor to mint the
  `final_report` under the right parent, it must hold the `dispatch` `span_id` for that
  `taskId` when FINAL_REPORT arrives. The supervisor already keeps per-task correlation
  state keyed by `taskId`; the span_id→state association is a **tracing addition in S4**.
  Do not assume `inFlightTaskIds` already stores span ids — it stores `taskId`, and the
  mapping is net-new.
- **A PROMPT is completed by a RESPONSE, not a FINAL_REPORT.** A `FINAL_REPORT` is the
  work-order result; a prompt is answered by `RESPONSE`. The supervisor closes the `prompt`
  span when the matching RESPONSE arrives. No `final_report` span is created for a prompt
  response, so `final_report` is work-order-only (parent `dispatch`, scope `taskId`).
- **Peer-originated prompts are not implemented and not planned (#41, ADR `docs/adr/0002-peer-to-peer-prompts-deferred.md`).** Today only the supervisor sends `prompt`
  frames, so the prompt-path cross-process edge is exercised only for supervisor-originated
  prompts. If the S4 scenario has none, the prompt-path cases in A5/A8 are unreachable and
  present for forward-compatibility only.
- `validation.command` spans exist only when validation is configured AND code changed
  (`runValidation` returns `not-configured`/`skipped` otherwise). Zero or one span per
  configured command.
- `tool` spans carry the tool name in `attributes` (e.g. `read`, `edit`, `bash`); the span
  name stays `tool` so the taxonomy stays closed.
- `model.call` from the handoff's illustrative diagram maps to the peer session's
  `message_start`/`message_end` events; it is optional and not part of the D5 gate.

### 3.3 Cross-process propagation (D4(b))

The one required cross-process parent edge, in both implementations:
1. The supervisor mints `dispatch` (span_id `d`) and writes the W3C `traceparent` carrying
   `d` onto the WORK_ORDER envelope (D3: it **supplements** `correlationId`, never replaces
   it).
2. The peer reads `d` and mints `peer.turn` with `parent_span_id = d`.
3. The peer mints nested `tool` spans under that `peer.turn`.

A supervisor-originated `prompt` is the same shape: the sender mints `prompt` (span_id `p`),
writes `traceparent` carrying `p` onto the PROMPT envelope, and the target peer mints
`peer.turn` with `parent_span_id = p`.

The oracle proves this edge worked by checking `peer.turn.parent_span_id` equals the
`dispatch`/`prompt` `span_id`: a span minted in a different OS process can only match if the
context actually crossed the socket.

### 3.4 Span links, not parenthood

A `link` records an additional causal edge that is not parenthood. The defined case:
`await_response` unblocks on another agent's event — the waiter's span links to the event's
span. Links never change `parent_span_id`; the parent chain stays a tree. A link is valid
only when an application event justifies it (graded in A8).

### 3.5 Classification (D5)

- run-level: `run`, `finalize`, `validation.command` — validated against their run and
  parent; `scope_id = null`.
- work-order-level: `dispatch`, `peer.turn`, `tool`, `final_report`, `prompt` — validated
  against their scope (`scope_id`); every such span carries a non-null `scope_id`.

### 3.6 Completeness and abort

Every completed span has `start_time ≤ end_time`. An aborted turn (peer aborted, `kill_all`,
user abort) closes its open spans with `status = "aborted"`; an open span never closed is a
failure, not silently dropped.

## 4. The expected-execution-graph oracle (the D5 gate)

### 4.1 Inputs

- `spans: SpanRecord[]` — everything either prototype emitted for one run.
- `facts` — application ground truth, recorded independently of tracing, for one fixed S4
  scenario:
  - `run_id`
  - `work_orders: { taskId, agentId }[]` — dispatched via `Runtime.dispatch`
  - `prompts: { correlationId, from, to, sender_scope }[]` — sent via `PeerMessaging.sendPrompt`; `sender_scope` is the scope the sender held when sending (`taskId`, or `"run"`)
  - `tool_executions: { execution_id, scope_id, agentId, tool }[]` — tool calls that
    actually ran, independently recorded with an execution id assigned **at invocation
    time**, not inferred afterward from `tool-calls.jsonl` ordering
  - `validation_commands: { execution_id, command }[]` — configured commands actually run;
    `execution_id` distinguishes repeated invocations of the same command
  - `justified_links: { from_scope, to_scope, reason }[]` — application events that justify
    a cross-scope causal link (e.g. an `await_response` unblocked by another agent's event)
  - `concurrency: { a: taskId, b: taskId }[]` — pairs known to have overlapped in time

  **S4 wiring precondition (F1):** A unique `execution_id` must be assigned when each
  tool invocation (and each validation-command invocation) is scheduled or begins.
  The same identity must be passed to **both** the independent operation record and
  the span emitter when the span is minted. The current `tool-calls.jsonl` lacks a
  per-call unique id; assigning one later by log order, positional pairing, or tool
  attributes is **not valid**. The throwaway harness may add this instrumentation
  without changing production code. Both prototypes receive identical preassigned
  identities, and independent facts must never be derived from emitted spans.

  `execution_id` is an independent application/test-fixture identity, **not** a
  `span_id`. For operational spans, `operation_id` carries the corresponding identity:
  `taskId` for `dispatch`/`final_report`, `correlationId` for `prompt`, and
  `execution_id` for `tool`/`validation.command`. These fields are oracle-facing
  correlation metadata, not new OTel identifiers. A missing `operation_id` on any
  operational span (`dispatch`, `final_report`, `prompt`, `tool`, or
  `validation.command`) is itself a D5 failure; it cannot be skipped or inferred.

### 4.2 Assertions

**Initial S4 scenario boundary (F2):** Each `taskId` is dispatched exactly once and
produces exactly one `FINAL_REPORT` receipt. The fixed scenario excludes empty-report
re-asks, reassignment, `restart_agent` re-dispatch, and any retry that generates an
additional FINAL_REPORT for the same task. These exclusions apply **only to this
prototype gate**, not to the production tracing design. Before reusing this oracle
for general runs, give each distinct dispatch/report occurrence its own independently
assigned execution identity and revise the corresponding A9/A10 matching rules.

Every assertion is a predicate over `spans` + `facts`. Both prototypes must satisfy all of
them; a failure is a D5 failure.

**A1 — Trace identity and id format.** Exactly one span named `run`, with
`parent_span_id = null`. All spans share one `trace_id`. Every `trace_id` and `span_id` is a
valid OTel-compatible id (32 and 16 lowercase hex), nonzero, and every `span_id` is unique
within the trace. No identifier remapping is permitted at export (D1, B.5).

**A2 — Classification.** Every span's `kind` is consistent with its name per the taxonomy
table (3.2), which is the sole authority. Every work-order-level span has a non-null
`scope_id`; every run-level span has `scope_id = null`.

**A3 — Scope membership.** For every `work_orders.taskId T`, the spans with `scope_id = T`
are exactly `{dispatch, peer.turn*, tool*, final_report}` for that work order (starred = one
or more). No span from a different work order carries `T`, and no span of this work order
carries another scope. Same rule for each `prompts.correlationId` on the prompt path
(`{prompt, peer.turn*, tool*}`; no `final_report`).

**A4 — In-process parent.**
- `dispatch.parent_span_id = run.span_id`;
- `finalize.parent_span_id = run.span_id`;
- `validation.command.parent_span_id = finalize.span_id`;
- `tool.parent_span_id` = the enclosing `peer.turn.span_id`, **and** `tool.scope_id` =
  that `peer.turn.scope_id` (R3: a tool inherits its turn's scope);
- `final_report.parent_span_id` = the corresponding `dispatch.span_id` (same `taskId`).

**A5 — Cross-process parent (D4(b)).** For each `work_orders.taskId T`, **every** `peer.turn`
with `scope_id = T` has `parent_span_id` equal to the `dispatch` span with `scope_id = T`
(minted in the supervisor). Same for each `prompts.correlationId`: every `peer.turn` for that
id parents to its `prompt` span. This is the proof the context crossed the socket.

> Lifecycle check before freezing (R2): this hard-codes "every `peer.turn` for T parents to
> `dispatch(T)`". If a later turn for T is initiated by a separate message, its true causal
> parent may differ. Confirm against the actual dispatch/turn lifecycle before relying on
> this; for the fixed S4 scenario the stated rule holds.

**A6 — Parent isolation (D4(c), parent chain).** Except for explicitly authorized cross-scope
parent edges involving a `prompt`, every work-order-scoped span stays within its assigned
scope's parent hierarchy:
- every work-order-scoped span **except `dispatch` and `prompt`** has a parent with the
  **same** `scope_id` (a prompt-initiated `peer.turn` inherits the prompt's scope, so it
  satisfies this);
- `dispatch(T)`'s parent is `run`;
- `prompt(c)`'s parent is the sender's current span. This is the only authorized cross-scope
  parent edge, and the oracle verifies it against the independently recorded sender context:
  the parent span's scope must equal `facts.prompts.sender_scope` for `c`;
- no other span scoped to work order `T` has a parent resolving into a different scope. For
  every `concurrency` pair `{a, b}`, no `a`-scoped span parents into `b`'s tree, or vice versa.

This catches context leakage on the parent chain while permitting the one justified prompt
edge, and touches no links.

**A7 — Completeness.** In a completed trace, every span — including one with
`status = "aborted"` — has a non-null `end_time` with `start_time ≤ end_time`. A span left
open (null `end_time`) is a failure, never silently accepted. For a non-resumed run,
`run.end_time` equals the terminal event (finalize or abort). Resumed runs are out of scope
for the initial gate (3.1).

**A8 — Link validity.** Links are causal edges, never parenthood, and never unjustified:
- for every span, no `links[].span_id` equals its own `parent_span_id`;
- every link targets a span in a **different** scope's tree (a same-scope relationship is
  parenthood or nothing, never a link);
- every link corresponds to an entry in `facts.justified_links` (matching from-scope,
  to-scope, and reason). A link with no application justification is a failure.

Legitimate cross-scope causal links (D1) pass; fabricated or leak-shaped links fail.

**A9 — Coverage.** The trace is complete, not merely internally consistent. For the fixed S4
scenario, each independent operation recorded in `facts` must match **exactly one** span
of the appropriate operational type, using its independent identity:
- each `work_orders.taskId` → exactly one `dispatch` and exactly one `final_report`,
  both with `operation_id = taskId`, plus at least one `peer.turn` with the matching
  `scope_id`;
- each `prompts.correlationId` → exactly one `prompt` with
  `operation_id = correlationId`, plus at least one `peer.turn` with that `scope_id`;
- each `tool_executions.execution_id` → exactly one `tool` span with
  `operation_id = execution_id` and matching `scope_id`, `agent_id`, and tool name;
- each `validation_commands.execution_id` → exactly one `validation.command` span
  with `operation_id = execution_id` and matching command identity.

A missing or duplicate matching span is a D5 failure. In particular, two tool
executions with identical `scope_id`, `agent_id`, and tool name are distinct when
their independent `execution_id` values differ. A9 checks coverage against facts,
not just internal consistency of emitted spans.

**A10 — Reverse coverage (no invented spans).** Missing or blank `operation_id` on
any emitted operational span is an immediate D5 failure, even when other attributes
would match a recorded operation. Each emitted operational span
(`dispatch`, `final_report`, `prompt`, `tool`, `validation.command`) must match
**exactly one** independently recorded operation of its type by `operation_id`,
with all applicable scope/agent/name attributes agreeing. No fact may be reused
to justify a second span of the same operational type. A span with no matching fact,
a mismatched identity, or a duplicate match is a D5 failure. Together A9 and A10
require a bijection **per operational span type** between recorded operations and
emitted spans. `peer.turn` remains lifecycle-driven, with at-least-one coverage
(A9) and the scope/parent requirements (A3–A5), not a fixed one-to-one count.

### 4.3 What this deliberately does not assert

- Exact timing values — only ordering and non-negativity.
- The number of `peer.turn` spans per work order beyond at-least-one (A9) — lifecycle-driven.
  `tool`, `dispatch`, `final_report`, `validation.command`, and `prompt` spans are pinned
  one-to-one to independent operation identities by A9 and A10.
- Which implementation produced the span — the oracle is implementation-agnostic by
  construction; independent `facts` (including `scope_id` and operation identities)
  are the oracle’s ground truth, never tracer-generated ids.

## 5. V4 note (schema constraint, not implemented here)

Cross-process propagation adds a `traceparent` (or equivalent span-context) field to the A2A
envelope. `A2AEnvelopeSchema` and every `payloadSchemas[*]` are `z.strictObject` and the bus
rejects unknown keys, so the event schema must be updated before either prototype can
propagate context. Noted, not done — it belongs to S4/S6.

## 6. Non-goals

- No metrics, collector, or egress (D2).
- No replacement of `conversation.jsonl` / `tool-calls.jsonl` — spans are additive
  observability, not the state store.
- No decision on SDK vs fields-only (deferred to S5/D6).
- No resume-path testing in the initial gate (3.1).
