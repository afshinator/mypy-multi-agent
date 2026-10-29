# Run inspection UI — research

How to build a webapp that inspects a finished task run's `run-details/` directory and presents the results. Part 1 and Part 2 are grounded in this repo's code and a real run (`mypi-tasks/s6-tracing/run-details/`, `mypi-tasks/r1-fixes/run-details/` at the time of writing; `run-details/` is gitignored, so those artifacts are not in the tree). Part 3 is grounded in primary-source docs fetched via curl. Part 4 separates cited facts from recommendations.

---

## Part 1 — What a finished run leaves behind

### Layout

One task directory per run, under `<taskDir>/<task>/` — `taskDir` is the first entry of the root config's `taskDirs`, `mypi-tasks` here (`src/pi/session-path.ts`, `docs/agent-config-guide.md` §7):

```text
<taskDir>/<task>/
  session.yaml          # trackable; not ignored
  run-details/          # gitignored (root .gitignore: "run-details/")
    plan.md
    findings.md
    final.md
    conversation.jsonl
    tool-calls.jsonl
    spans.jsonl         # written by the supervisor and every peer; present in most runs on disk
    run-state.json
    scorecard.json      # written by default; suppress with session.record_scorecard = false
    .peer-<id>.json     # transient; removed on /finalize
```

`final.md`/`findings.md` are system-written (the `finalize` tool on normal completion, the abort path on user abort) — never hand-written by the supervisor (`docs/agent-config-guide.md` §7). Task-owned artifacts can also appear (e.g. `findings.excalidraw`, `ponytail-review.md`), but only `plan.md` is a run-contract requirement.

### Artifact inventory

**`plan.md`** — the supervisor's working plan; free text, no schema.
- Written by the supervisor (LLM) via its own tools; the extension's briefing instructs it to write it (`src/pi/extension.ts`, the `Write plan.md and all per-run files...` line).
- Only system-enforced artifact: `checkRunContract` fails finalize if it is absent — `REQUIRED_ARTIFACTS = ["plan.md"]` (`src/validation/run-contract.ts`).
- Real example in this tree: `mypi-tasks/run-inspector/run-details/plan.md` (spec pointers, ownership table, build order).

**`final.md`** — terminal decision record. Writer: `FinalWriter.write` (`src/artifacts/final-writer.ts`).
- YAML frontmatter:
  - `status`: `success` | `failure` | `aborted` (`Finalization.outcome`, `src/supervisor/finalization.ts`)
  - `exit_code`: `0`/`1`/`2`/`3` (`EXIT` in `src/runtime/exit.ts`; 2 = user abort, 3 = config error defined but unused)
  - `total_cost_usd`, `total_tokens`, `supervisor_cost_usd`, `supervisor_tokens`
  - `agents:` list of `{ name, cost_usd, tokens }`
  - costs come from `CostBreakdown` (`src/supervisor/finalization.ts`), computed in `Runtime.costBreakdown`
- Body sections rendered by `FinalWriter`:
  - `## Summary` — total-cost line (peers vs supervisor split, unpriced-model note) + `Accomplished` / `Left` lists (`FinalSummary`).
  - `## Decision` — supervisor's free-text decision record (`Finalization.decision`).
  - `## Criteria` — one checkbox per DoD verdict: `- [x| ] <criterion> — <evidence>` (`CriterionVerdict`, `src/contracts/criteria.ts`).
  - `## Advisory (semantic, non-gating)` — optional Jev verdict advisory (`VerdictAdvisory`, `src/jev/verdict-advisory.ts`).
  - `## Peer findings` — pointer to `findings.md`.

**`findings.md`** — raw per-peer `FINAL_REPORT`s, unedited. Writer: `FinalWriter.findings` (`src/artifacts/final-writer.ts`).
- Header + one `## <agentId>` section per report; empty reports annotated `_(empty report - peer stopped before reporting)_`.
- Source records: `FinalReport` (`{ agentId, report }`), built by `finalReports` in `src/supervisor/finalization.ts`.

**`conversation.jsonl`** — the orchestration timeline, append-only JSONL. Writer: `Runtime.log` (envelopes) and `Runtime.logEntry` (synthetic events), both appending through `ConversationLog.append` (`src/logging/conversation-log.ts`).
- Envelope record shape (`Runtime.log`): `{ timestamp, type, id, sender, recipient, payload, correlationId?, taskId? }`.
  - `type` ∈ `EVENT_TYPES` (22 values: `AGENT_REGISTER`, `WORK_ORDER`, `ACK`, `PROMPT`, `RESPONSE`, `INTENT_TO_MODIFY`, `LOCK_REQUEST`, `LOCK_ACQUIRED`, `LOCK_RELEASED`, `AGENT_CRASHED`, `AGENT_UNUSABLE`, `AGENT_STALLED`, `STOP_AGENT`, `STOP_ALL`, `KILL_ALL`, `FINAL_REPORT`, `ERROR`, `HEARTBEAT`, plus defined-but-unused `AGENT_REGISTERED`/`STATUS`/`STATE_CHANGED`/`BUDGET_THRESHOLD`) — `src/contracts/a2a-schema.ts`.
  - `payload` validated against `payloadSchemas` per type (same file). Key payloads: `WORK_ORDER {taskId, action, contextFiles, constraints, localDoD}`; `PROMPT {agentId, text}`; `RESPONSE {agentId, text, usage?, criteria?}`; `FINAL_REPORT {agentId, report, usage?, criteria?}`; `RESPONSE.usage`/`FINAL_REPORT.usage` = `{cost, tokens, cacheReadTokens?}`; `criteria` = `CriterionVerdict[]` (`src/contracts/criteria.ts`).
  - `HEARTBEAT` is not logged (`Runtime.log` early-returns on it).
  - `taskId` is added only on `FINAL_REPORT` records (from the in-flight task map).
- Synthetic records via `logEntry` (heterogeneous keys, no fixed schema): `{type:"FINALIZED", outcome, exitCode, timestamp}`, `{type:"ERROR", event, ...}` (`correlation-timeout`, `peer-terminal`, `run-contract`, `stale-attestation`, `sender-mismatch`, `scorecard-write-failed`, `run-state-write`, `envelope-handler-threw`), `{type:"RETRY", agentId, event:"peer-retry", attempt, maxAttempts}`, `{event:"restart-agent", ...}`, `INJECTION_GATE_*` entries.
- Observed distinct types in the s6-tracing run: `AGENT_REGISTER`, `PROMPT`, `RESPONSE`, `INTENT_TO_MODIFY`, `WORK_ORDER`, `LOCK_REQUEST`, `LOCK_ACQUIRED`, `LOCK_RELEASED`, `FINAL_REPORT`, `FINALIZED`.

**`tool-calls.jsonl`** — one line per completed peer tool call. Writer: `toolCallLogger` (`src/peer/tool-call-logger.ts`), appending via `ConversationLog.append`; path from `peerToolLogPath` (`src/peer/peer-config.ts`).
- Record shape: `{ timestamp, agentId, toolName, toolCallId, args, isError, durationMs }`.
- `args` is the tool's raw argument object (e.g. `{command, timeout}` for `bash`, `{path, offset, limit}` for `read`); `durationMs` omitted when the start event was missed.
- Observed tools in s6-tracing: `bash`, `ls`, `grep`, `find`, `read`, `write`, `edit`.

**`run-state.json`** — versioned resume snapshot at work-order boundaries. Writer: `writeRunState` / `buildRunState` (`src/runtime/run-state.ts`), triggered from `Runtime.writeRunStateSnapshot`.
- Schema `RunStateV1Schema` (`src/runtime/run-state.ts`):
  - `version: "1"`, `configHash` (SHA-256 of raw `session.yaml`, `hashConfig`), `planPointer` (default `"run-details/plan.md"`), `startedAtMs`, `totals {costUsd, tokens}`.
  - `agents[]`: `{ id, state, model, usage {costUsd, tokens, cacheReadTokens}, budget {maxCostUsd, maxTokens?}, lastCompletedWorkOrder, inFlightTaskId }`.
  - `state` ∈ `PENDING | WORKING | DONE | CRASHED | STOPPED` (`AGENT_STATE_VALUES`).

**`spans.jsonl`** — fields-only trace spans, append-only JSONL, OTel-compatible ids. Writer: `FieldsTracer.endSpan` emits each completed `SpanRecord` through a sink; the sink is wired in the `Runtime` constructor (`src/runtime/runtime.ts`, `this.spanLog = new ConversationLog(join(this.runDetailsDir, "spans.jsonl"))`) and in `peer-main.ts` (`src/peer/peer-main.ts`, `spanLog`/`tracer`). Supervisor and every peer append to the same file.
- Record shape `SpanRecord` (`src/tracing/tracing.ts`): `{ trace_id, span_id, parent_span_id, name, kind, scope_id, agent_id, start_time, end_time, status, links, operation_id?, attributes? }`.
  - `name` ∈ `SpanName` = `run | finalize | validation.command | dispatch | peer.turn | tool | final_report | prompt`.
  - `kind` ∈ `run-level | work-order-level`; `status` ∈ `ok | error | aborted`.
  - `links` = `Array<{ span_id, reason }>`.
  - Propagation via W3C `traceparent` (`formatTraceparent`/`parseTraceparent`), injected on `WORK_ORDER`/`PROMPT`, extracted peer-side in `PeerTraceState.startTurnFrom` (`src/tracing/peer-trace.ts`).
- Observed now: 17 of the 29 on-disk runs under `mypi-tasks/*/run-details/` contain `spans.jsonl`, and `mypi-tasks/run-inspector/run-details/spans.jsonl` holds 544 spans under one `trace_id`, all eight span names, and no open span. The runs inspected when this was written (`.mypi/s6-tracing`, `.mypi/r1-fixes`, `.mypi/scorecard`) had none: s6-tracing _built_ the sink, and the other two predate S6.

**`scorecard.json`** — per-run health scorecard, written by default (`session.record_scorecard: false` suppresses it). Writer: `recordScorecard` → `writeScorecard` (`src/scorecard/record.ts`), built by `buildScorecard` (`src/scorecard/scorecard.ts`).
- Shape `RunScorecard`: `{ taxonomyVersion, outcome, exitCode, outcomeExitMismatch, dod, falseSuccess, turnDurationsMs, toolTimeMs, toolTimeByAgentMs, toolCalls, toolErrors, retries, correlationTimeouts, agentCrashed, agentUnusable, agentStalled, stopAgentReasons, cost, modelRoster, mistakes }`.
- Privacy boundary: derived metrics only; prompts/reports/system prompts/tool args/evidence never copied (`src/scorecard/scorecard.ts` header, `src/scorecard/record.ts`).
- Real example in this tree: `mypi-tasks/05-interpretation/run-details/scorecard.json`.

**`.peer-<id>.json`** — transient per-peer bootstrap config, written by `Runtime.writePeerConfig`, removed by `Runtime.cleanup` on `/finalize`; left behind on user abort for inspection (`docs/agent-config-guide.md` §7).

---

## Part 2 — Visual forms per data type

| Data                                      | Fits                                                                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spans.jsonl` (`SpanRecord`)              | Trace waterfall/Gantt timeline (bars positioned by `start_time`, sized by duration); flame-graph tree (nested by `parent_span_id`); span-detail drawer (attributes, `links`, `status`, `kind`); per-agent swimlanes using `agent_id`. |
| `conversation.jsonl` envelopes            | Timeline / event log; sequence view of supervisor↔peer message exchange; turn-pairing (open `WORK_ORDER`/`PROMPT` ↔ close `FINAL_REPORT`/`RESPONSE` via `correlationId`/`taskId`); peer roster cards with state; error/event filters. |
| `tool-calls.jsonl`                        | Table (timestamp, agent, tool, duration, error); tool-duration bar chart per agent; error-rate stat; drill-down into `args`.                                                                                                          |
| `run-state.json`                          | Per-agent status cards (`state`, `usage`, `budget`); spend/token progress bars vs `maxCostUsd`/`maxTokens`; last-completed-work-order list.                                                                                           |
| `final.md` frontmatter + `scorecard.json` | Stat cards (total cost, tokens, exit code, outcome); cost/token breakdown table per agent; DoD checklist; mistake-class summary.                                                                                                      |
| `final.md` `## Criteria`                  | DoD checklist (pass/fail per criterion with evidence).                                                                                                                                                                                |
| `findings.md`                             | Per-peer report sections; empty-report badges.                                                                                                                                                                                        |
| `plan.md`                                 | Rendered Markdown panel.                                                                                                                                                                                                              |

---

## Part 3 — Best practices for displaying trace/observability data

All claims cited to pages fetched via curl. Where no primary source covers a point, it is marked **[recommendation]**.

### Span structure (the data model behind any view)

- A **trace** is a set of spans sharing one `trace_id`; hierarchy is expressed by `parent_id` matching another span's `span_id`; the root span has no `parent_id` — https://opentelemetry.io/docs/concepts/signals/traces/.
- A **span** carries: name, parent span id (empty for root), start/end timestamps, span context (trace id, span id, trace flags, trace state), attributes (key-value), events (timestamped log-like records), links (causal association to spans outside the parent-child relation), status (`Unset`/`Error`/`Ok`), and kind (`Client`/`Server`/`Internal`/`Producer`/`Consumer`) — same page, "Spans" section.
- Attributes vs events: attach data to a **span event** when the timestamp of the occurrence is meaningful; otherwise use a **span attribute** — same page, "When to use span events versus span attributes".

### Waterfall / Gantt timeline

- Grafana's trace view renders a **timeline**: "each span row consists of Expand children, Service name, Operation name, Span duration bar"; a **minimap** shows a condensed timeline that zooms the main view — https://grafana.com/docs/grafana/latest/explore/trace-integration/ ("Timeline", "Minimap").
- The **span duration bar** highlights the trace's **critical path** with a darker segment (CRISP algorithm); a "Show critical path only" toggle focuses on spans that drive end-to-end latency — same page. Grafana's traces panel also has a "Select critical path" span-filter option — https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/traces/. Jaeger exposes the same via `criticalPathEnabled` — https://www.jaegertracing.io/docs/latest/frontend-ui/.

### Span detail drill-down

- Grafana span details show **span attributes**, **resource attributes**, **events**, and **links**; events are "log-like records ... timestamp, name, and key-value pairs"; links represent non-parent-child associations (e.g. async queue handoff) — https://grafana.com/docs/grafana/latest/explore/trace-integration/ ("Span details", "Events", "Links").
- SigNoz span-details panel shows span name/service, percentile ranking, percentage of total execution time, timestamp, linked-span count, service, status code, trace id, span kind; organized into tabs (Overview = attributes, Events, Logs, Metrics) — https://signoz.io/docs/userguide/span-details.md.

### Flamegraph vs waterfall — when each applies

- SigNoz renders both, synchronized: **flame graph** = "hierarchical representation of the trace, showing the nested relationships between spans" (renders 100,000+ spans at once); **waterfall chart** = "detailed timeline view, illustrating the sequence and duration of each span" (10,000+ spans with virtual scrolling) — https://signoz.io/docs/userguide/span-details.md.
- Flamegraph definition (SigNoz glossary): "shows each span as a horizontal bar positioned by start time and sized by duration, making the critical path and the slowest child operations obvious" — https://signoz.io/docs/userguide/span-details.md (glossary link).
- **[recommendation]** Use the waterfall (time-on-x-axis) when comparing durations and ordering is the point; use the nested flame-graph/tree when parent-child structure is the point. For a single run with one `run` root and few spans, one synchronized view (tree + duration bars) suffices; two separate views are overkill.

### Service / topology graph

- Grafana trace view offers a **node graph** (spans as nodes, or a service graph based on the trace) and a **service graph** (rates, error rates, durations + service relationships) — https://grafana.com/docs/grafana/latest/explore/trace-integration/ ("Node graph", "Service graph"). Service graphs are generated from span data by Tempo's metrics-generator or Alloy, then shown as a graph in Grafana — https://grafana.com/docs/tempo/latest/metrics-generator/service_graphs/.
- Jaeger supports two topology graphs: **System Architecture** (one-hop service dependencies) and **Deep Dependency Graph** (transitive dependencies through a focal service, node granularity services or endpoints) — https://www.jaegertracing.io/docs/latest/features/.
- Jaeger's model "represents traces as directed acyclic graphs (not just trees) via span references" — same page. **[recommendation]** For this repo, the topology is fixed (supervisor ↔ peers); a service graph adds little. The run's own spans are already a DAG, so the tree/waterfall must tolerate non-tree links (`SpanRecord.links`) — see Jaeger's DAG statement.

### Aggregated dashboard vs per-trace drill-down

- SigNoz trace explorer separates the two levels: a **list/traces view** (rows per span/trace, sortable, columns) plus **time-series** and **table** views with a query builder supporting `count`, `avg`, `p99` and Group By/Having/Order By/Limit, for aggregation — https://signoz.io/docs/userguide/traces.md. Drill-down opens the per-trace **trace details** page — https://signoz.io/docs/userguide/span-details.md.
- Grafana's Traces Drilldown app works from **RED metrics derived from traces** ("use Rate, Errors, and Duration metrics ... without writing TraceQL") and generates automatic visualizations — https://grafana.com/docs/grafana/latest/explore/simplified-exploration/traces/. A dashboard-level traces **panel** renders one trace by `traceID` variable, with a TraceQL **table** to pick the trace — https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/traces/.
- **[recommendation]** Follow the same two-level shape: a run summary (aggregate stats) landing page, then per-trace/per-agent drill-down.

### Rendering large traces client-side

- Jaeger's web UI is "implemented in Javascript as a React application" and "display[s] traces with tens of thousands of spans (e.g. we tried a trace with 80,000 spans)" — https://www.jaegertracing.io/docs/latest/features/.
- SigNoz renders 100,000+ spans in the flame graph and 10,000+ spans in the waterfall "with virtual scrolling for smooth navigation" — https://signoz.io/docs/userguide/span-details.md.
- **[recommendation]** No fetched primary source documents a _backend-less, static/local-first_ trace viewer; the closest facts are the two above (client-side React UI + virtual scrolling). Treat "parse JSONL in the browser, no backend" as my recommendation, not a vendor fact.

---

## Part 4 — Recommendation

**[recommendation]** Build a static single-page app that loads a `run-details/` directory client-side and parses JSONL in the browser. No backend.

### Views, mapped one-to-one to Part 1 data

1. **Run summary / stat cards** ← `final.md` frontmatter + `scorecard.json` (fallback when absent): outcome, exit code, total cost/tokens, supervisor vs peer split, per-agent cost/tokens table.
2. **DoD checklist** ← `final.md` `## Criteria` (`CriterionVerdict`): pass/fail per criterion with evidence; link to `findings.md`.
3. **Trace waterfall + tree** ← `spans.jsonl` (`SpanRecord`): one synchronized view (nested tree + duration bars), swimlaned by `agent_id`; span-detail drawer showing `attributes`, `links`, `status`, `kind`, `operation_id`.
4. **Timeline / event log** ← `conversation.jsonl`: chronological envelope log with type/actor filters; pair `WORK_ORDER`/`PROMPT` ↔ `FINAL_REPORT`/`RESPONSE` by `correlationId`/`taskId` (mirror `turnKey` in `shared/turn.ts`).
5. **Tool-call table** ← `tool-calls.jsonl`: columns timestamp/agent/tool/args/duration/error; per-agent duration and error stats.
6. **Peer roster cards** ← `run-state.json` `agents[]`: state, model, usage vs budget bars, last completed work order.
7. **Plan + findings** ← `plan.md`, `findings.md`: rendered Markdown panels.

### Tech direction

- **Static SPA, no backend.** Parse JSONL client-side (`fetch` + streaming line reader); `File System Access API` or a `<input type=file webkitdirectory>` drop for the directory. `run-state.json`/`scorecard.json` are plain JSON; `final.md` frontmatter is YAML (needs a small YAML parser).
- Tradeoffs: (+) zero infrastructure, works on a finished frozen run, files are append-only JSONL with bounded size (s6-tracing ≈ 100–250 KB per log, 262 tool calls, 173 conversation lines — trivially small); (–) no full-text search across large logs without an index (fine at this scale), browser file-access API support is Chromium-only, and `spans.jsonl` may be absent (Part 1) so the waterfall view must degrade gracefully.
- **[recommendation]** Reuse the repo's own parse semantics: one JSON object per line, blank/malformed lines skipped, non-object lines ignored — exactly `readJsonl` (`src/logging/conversation-log.ts`). Deriving turn durations by identity (not timestamp) mirrors `turnDurations`/`turnKey` (`shared/turn.ts`).

### Key implementation warning

`spans.jsonl` is written by **multiple processes** (supervisor + each peer) appending to one file, and is present in most runs on disk here — the trace view must tolerate concurrent-append ordering (lines may not be globally sorted by `start_time`; sort client-side).

---

## Sources (fetched)

- https://opentelemetry.io/docs/concepts/signals/traces/ (and its `/index.md` markdown form)
- https://www.jaegertracing.io/docs/latest/
- https://www.jaegertracing.io/docs/latest/features/
- https://www.jaegertracing.io/docs/latest/frontend-ui/
- https://www.jaegertracing.io/docs/latest/architecture/
- https://grafana.com/docs/tempo/latest/
- https://grafana.com/docs/grafana/latest/explore/trace-integration/
- https://grafana.com/docs/grafana/latest/explore/simplified-exploration/traces/
- https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/traces/
- https://grafana.com/docs/tempo/latest/metrics-generator/service_graphs/
- https://signoz.io/docs/
- https://signoz.io/docs/userguide/traces.md
- https://signoz.io/docs/userguide/span-details.md
