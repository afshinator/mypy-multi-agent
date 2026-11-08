# Ticket automation redesign research (2026-11-08)

## Scope and method

This report examines the shipped batch/triage/prepare path and external, first-party patterns for making ticket delivery more reliable. **Verified** means directly observed in this repository or documented by the linked project owner. **Proposal** is a design option, not an existing capability.

## Current system (verified)

| Area                | Evidence                                                                   | Consequence                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare ordering    | `src/batch/prepare.ts:1-6`                                                 | Manifest/model validation precedes comment and `ready-for-agent`; ordering is a safety invariant.                                       |
| Multi-pass triage   | `src/batch/prepare.ts: attemptTwice`, `repairRound` (around lines 250-430) | Triage, independent verifier, bounded repair/re-verify; retries are site-scoped and recorded.                                           |
| Claims verification | `src/batch/prepare.ts: verifyTicket`                                       | Verifier executes claim commands in a clone; malformed shape and mismatches refuse or trigger one repair round.                         |
| Manifest validation | `src/batch/manifest.ts:1-45`                                               | YAML template is merged with ticket DoD, round-tripped through strict schema, and criteria equality is checked.                         |
| Model preflight     | `src/batch/preflight.ts:1-10, resolveModels`                               | Exact provider/model matches are required; fuzzy CLI search results are rejected.                                                       |
| Tracker boundary    | `src/batch/tracker.ts:1-10`                                                | GitHub is accessed only through an adapter; comments use REST numeric IDs and marker upserts. Issue bodies are never modified.          |
| Run completion      | `src/batch/executor.ts:1-8, runTicket`                                     | Driver polls `final.md` twice and waits for transient peer files to disappear because runtime emits no completion signal.               |
| Retry/resume        | `src/batch/executor.ts: D12` and `docs/batch-guide.md`                     | Startup failure retries once; there is no general resume (a retry is a new batch).                                                      |
| Durability          | `docs/adr/0004-batch-driver-outside-the-runtime.md`                        | Batch state is files; records are intended to be frozen and artifacts copied out of worktrees.                                          |
| Runtime contract    | `docs/agent-config-guide.md §8`                                            | Finalize requires DoD attestation, mechanical validation, and `plan.md`; validation runs are bounded.                                   |
| Known gaps          | `docs/batch-guide.md §Known limits`                                        | No merge/push; satisfied no-op is failure; verifier checks every row (cost); no retemplate; claims may observe changing external state. |

### Reliability risks implied by these boundaries

1. **Polling is a weak completion protocol.** `final.md` plus mtime stability is an inference, not an acknowledged task state. Crashes between commit and writeback can leave ambiguous records.
2. **At-least-once external writes.** Marker comments and labels are separate GitHub calls; a network fault between them can produce a valid local acceptance but incomplete tracker state.
3. **No durable orchestration state machine.** Files are authoritative, but there is no lease/heartbeat for a worker that dies mid-ticket and no automatic continuation from the last completed phase.
4. **Verifier cost scales with every claim row.** The guide explicitly notes sampling is not implemented.
5. **Branch correctness is under-verified.** A success requires a commit, but there is no built-in post-run patch application/replay check, merge simulation, or regression test against the base branch beyond the run's declared validation.

## External patterns (verified from primary sources)

| Pattern                           | Primary source                                                                                                                                                        | Fact                                                                                                                                      | Applicability                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| SWE-bench task harness            | [SWE-bench README](https://github.com/SWE-bench/SWE-bench), [paper](https://arxiv.org/abs/2310.06770)                                                                 | Tasks package issue text, a repository/base commit, and tests; evaluation applies a generated patch and runs a standardized test harness. | Adopt immutable base snapshots, patch extraction, and replay tests before marking success.                            |
| SWE-agent trajectory/reproduction | [SWE-agent docs](https://github.com/SWE-agent/SWE-agent)                                                                                                              | Agent trajectories are recorded and evaluated by running tests in a controlled environment.                                               | Preserve command/tool traces as first-class evidence; rerun candidate patches in a clean checkout.                    |
| OpenHands runtime                 | [OpenHands repository](https://github.com/All-Hands-AI/OpenHands)                                                                                                     | Separates agent runtime from task/evaluation harness and supports reproducible local execution.                                           | Keep tracker policy outside runtime, but expose a stable task/evaluation API.                                         |
| Temporal durable execution        | [Temporal docs: durable execution](https://docs.temporal.io/encyclopedia/durable-execution)                                                                           | Workflow progress is persisted; activities can retry, timeout, and resume after worker failure.                                           | Replace implicit file polling with explicit phase state, heartbeats, leases, and retry policies.                      |
| Temporal workflow history         | [Temporal docs: event history](https://docs.temporal.io/workflows)                                                                                                    | Workflow event history is append-only and used to reconstruct state deterministically.                                                    | Keep an append-only event log alongside materialized JSON records; make every external side effect idempotent.        |
| GitHub issue forms                | [GitHub issue form syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues/using-issue-forms)                                       | Structured YAML forms collect typed fields and required inputs before an issue is opened.                                                 | Add machine-readable ticket fields (scope, constraints, test command) instead of extracting all semantics from prose. |
| GitHub Actions checks             | [Checks REST API](https://docs.github.com/en/rest/checks/runs), [Actions events](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)    | Checks expose named runs, conclusions, and annotations; workflows can trigger on issue/PR events.                                         | Publish prepare/run/patch-verification as check runs, not only comments and labels.                                   |
| GitHub merge queue                | [Merge queue docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | Queue validates PRs against the latest target branch before merge.                                                                        | Optional final phase can open a PR and rely on queue checks for integration correctness.                              |
| LangGraph durable execution       | [LangGraph durable execution](https://langchain-ai.github.io/langgraph/concepts/durable_execution/)                                                                   | Graph nodes checkpoint state; interrupted runs can resume, with guidance to make side effects idempotent.                                 | Model prepare/verify/repair/run as resumable nodes with explicit idempotency keys.                                    |
| OpenAI structured outputs         | [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs)                                                                                | JSON-schema-constrained responses reduce parse/shape failures where supported.                                                            | Replace ad-hoc markdown parsing for triage/verdict blocks with versioned JSON schemas; retain textual evidence.       |
| JSON Schema                       | [JSON Schema specification](https://json-schema.org/specification)                                                                                                    | Schemas define machine-checkable structure independent of a specific model/provider.                                                      | Version report, verifier, and outcome schemas; reject unknown fields and preserve raw payloads.                       |

## Redesign options and trade-offs

### Option A — Incremental hardening (lowest risk)

Keep the current driver and add: structured JSON report/verdict schemas; idempotency keys for GitHub writes; a `state.json` phase record; post-run clean-checkout patch replay; and check-run publication. **Pros:** small migration, preserves proven ordering and safety guards. **Cons:** still a bespoke poller and limited recovery semantics.

### Option B — Durable workflow controller (recommended target)

Implement a workflow state machine (Temporal, or a small append-only event-log controller) with phases `snapshot → triage → verify → repair? → manifest → preflight → execute → patch-verify → publish`. Each phase has input/output hashes, retry policy, timeout, heartbeat, and idempotency key. Materialized files remain for audit and CLI compatibility. **Pros:** crash recovery, observable state, deterministic retries, explicit side-effect boundaries. **Cons:** operational dependency (Temporal) or substantial controller code; migration complexity.

### Option C — Queue/worker service

GitHub webhook/Actions event enqueues tickets; stateless workers claim leases and write results. **Pros:** parallel throughput and central scheduling. **Cons:** duplicate delivery and lease correctness become mandatory; local-first philosophy is weakened; credentials and service uptime required.

### Option D — PR-first autonomous loop

After patch verification, open a PR and let GitHub Checks + merge queue arbitrate integration. **Pros:** native review/audit and branch protection. **Cons:** changes current contract (branch-only deliverable), requires repository permissions and policy decisions about auto-merge.

## Recommended architecture

Adopt **Option A immediately, converging on Option B with optional D**:
1. **Canonical ticket snapshot.** At prepare start, persist issue number, title/body, labels, updated timestamp, and source revision. Refuse or re-triage if the ticket changed before execution.
2. **Typed extraction contract.** Define versioned JSON schemas for triage (`kind`, claims, DoD), verifier verdicts, repair deltas, and outcomes. Require model responses to validate against schema; keep raw response and parser diagnostics. Use provider structured-output mode when available, otherwise schema-repair retry.
3. **Explicit phase state + event log.** Write append-only events (`phase_started`, `attempted`, `accepted`, `refused`, `side_effect_applied`) with correlation/idempotency keys. Materialized `acceptance.json`, `refusal.json`, and `run.json` remain projections.
4. **Lease and resume.** A batch worker claims a ticket lease with expiry/heartbeat. On restart, resume from the last committed phase; never repeat a successful external side effect with a new key.
5. **Patch/branch verification harness.** Before success: export diff against recorded base SHA, apply it to a fresh checkout, run declared validation plus a minimal smoke suite, ensure commit is non-empty, and record patch hash/test logs. This mirrors SWE-bench's apply-and-test evaluation.
6. **Tracker side-effect adapter.** Keep GitHub calls behind `Tracker`, but make operations idempotent and reconcile labels/comments from local desired state. Publish a GitHub Check Run linking to immutable records; comments become human-readable summaries.
7. **Adaptive multi-pass policy.** Retain independent verifier and bounded repair. Add risk-based routing: large claim tables use deterministic command grouping/sampling plus mandatory full replay for changed rows; high-risk tickets escalate to a second model or human approval.
8. **Integration path (later).** Optionally open a PR after patch verification; let branch protection/merge queue run integration checks. Keep branch-only mode for local deployments.

## Phased rollout

| Phase                              | Deliverables                                                                                                                   | Exit criteria                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 0. Instrument (1–2 weeks)          | Event IDs, phase timings, snapshot/base SHA, patch hash, failure taxonomy; no behavior change.                                 | Every ticket has reconstructable phase timeline and cost/latency metrics.                   |
| 1. Typed boundaries (2–4 weeks)    | JSON schemas + strict validation for triage/verifier/repair/outcome; raw payload retention; idempotent tracker reconciliation. | Malformed responses never publish labels; replayed prepare is side-effect safe.             |
| 2. Patch harness (2–4 weeks)       | Clean-checkout apply, tests, diff/base verification, commit and artifact checks.                                               | Synthetic failures (missing commit, stale base, test regression) are caught before success. |
| 3. Durable resume (4–8 weeks)      | Append-only event store, leases, restart/resume CLI; initially file-backed, then evaluate Temporal.                            | Kill worker at each phase and resume without duplicate model spend or tracker writes.       |
| 4. Queue/PR integration (optional) | GitHub Check Runs, webhook/Actions trigger, PR + merge-queue mode.                                                             | End-to-end ticket-to-PR succeeds under branch protection; local mode remains supported.     |

## Decision guidance

- Do not remove current prepare ordering, independent verification, or refusal semantics until replacement tests prove equivalent safety.
- Prefer file-backed event sourcing first; adopt Temporal when concurrent workers, long waits, or cross-host recovery justify its operational cost.
- Treat model output as untrusted input: schema validation, bounded retries, and preserved raw evidence are mandatory.
- Success should mean **reproducible patch + passing verification on the recorded base**, not merely a stable `final.md` and non-empty branch.
