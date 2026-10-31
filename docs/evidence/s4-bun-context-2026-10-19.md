# S4 — fields-only vs OTel SDK: cross-process trace context (2026-10-19)

Prototypes for `docs/temp-handoffs/02-telemetry-correlation-handoff.md` S4, graded against the
`docs/trace-semantics-oracle.md` A1–A10 oracle. The probe is committed at
`scripts/bun-s4-probe/`; run `bun run main.ts` / `mutate.ts` / `run2p.ts` there to
reproduce.

## What was tested

Two tracing implementations, both emitting the normalized `SpanRecord` shape, on one
fixed scenario:
- **fields-only** — manual `SpanRecord` store + manual W3C `traceparent` inject/extract.
- **otel-sdk** — `@opentelemetry/sdk-trace` `TracerProvider` + `AsyncLocalStorageContextManager`
  - `W3CTraceContextPropagator` (`@opentelemetry/api` 1.9.1, `sdk-trace` 2.12.0, Bun 1.4.2).

Scenario (F2 boundary: one dispatch per task, no re-ask/retry/resume): one `run` root,
two **concurrent** work orders (T-A→peer-a, T-B→peer-b), one supervisor-originated
`prompt` (prompt-1→peer-a), five tool executions with independent `execution_id`s,
`final_report` per work order, `finalize` + two `validation.command`. `justified_links`
was empty (A8 exercised only as a negative case, below).

## Evidence, three layers

### 1. Oracle is non-vacuous (mutation test)

`grade()` was fed the known-good span set with one targeted corruption each, and the
expected assertion id was required to fire. **18/18 passed** — every assertion class
(A1–A10) rejects its own violation:
- A1: remove `run`, bad `trace_id`, duplicate `span_id`
- A2: `dispatch` wrong kind, run-level span with non-null scope
- A3: span with unknown scope
- A4: `dispatch` wrong parent, `tool` parent not `peer.turn`, `final_report` wrong parent
- A5: `peer.turn` parent ≠ its `dispatch`
- A6: cross-scope parent, A→B concurrency leak, `prompt` parent ≠ sender scope
- A7: span left open (`end_time = null`)
- A8: fabricated link with no justification
- A9: removed `tool` span (coverage gap), duplicated `tool` span
- A10: missing `operation_id`

### 2. In-process (real unix socket, shared process)

Both strategies: **17 spans, propagation PASS (3/3 edges), oracle A1–A10 PASS (0
failures)**, stable across repeated runs. The propagation check is not fixture-matching:
it captures the injected W3C `traceparent` string from the outbound envelope and asserts
`parseTraceparent(injected).spanId === extracted`, i.e. the id really round-tripped the
socket.

### 3. Two-process (the real cross-process boundary)

`run2p.ts` spawns each peer as a separate `bun peer.ts` child process over the unix
socket. The peer has no channel other than the frame itself to learn the supervisor's
span id, so a matching parent proves the traceparent crossed the socket. Both strategies:
**oracle A1–A10 PASS (0 failures), propagation PASS (3/3)**, stable across runs.

This layer caught a real bug the in-process layer masked: **fields-only did not propagate
`trace_id`** — its `extract` returned only the span id, so a peer minted spans under its
own random `trace_id`, splitting the trace. Fixed (`extract` now returns the trace id,
`startSpan` inherits the parent's). The SDK path needed no fix: `traceparent` extraction
carries the remote trace id, and `startSpan` inherits it. This is the D4(b) proof the
handoff said was still owed.

## Implementation facts found while building (recorded for S6)

- `@opentelemetry/sdk-trace` 2.x changed the API from 1.x: `TracerProvider` takes
  `{ spanProcessors: [...] }` (no `addSpanProcessor`), `SimpleSpanProcessor` takes
  `{ exporter }`, and `ReadableSpan` exposes `parentSpanContext.spanId` (not
  `parentSpanId`).
- The W3C propagator is stateless string format/parse, so inject/extract are identical
  across processes; the only per-process state is the context manager + tracer provider,
  which the two-process run exercises separately.

## Conclusion and what it does NOT conclude

Both implementations are **correct on D5** (the oracle) with real socket and real
cross-process propagation. A7 carries a 5 ms tolerance for SDK HrTime clock jitter.

Not concluded: **SDK vs fields-only.** D5 cleared for both; the selection is the D6
complexity/overhead comparison, which was not done. The fixed scenario excludes
abort/retry/resume and real `justified_links`; a general-run reuse needs the A9/A10
matching rules revised for distinct dispatch/report occurrences (noted in the oracle
doc). Bun 1.4.2/macOS arm64 only; re-run on a Bun bump.
