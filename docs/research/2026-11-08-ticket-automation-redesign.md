# Ticket automation redesign research

**Date:** 2026-11-08  
**Scope:** the batch/triage/prepare/run system and the recorded finance-hub batches `0012-multi-49-45` and `0013-multi-49-45`  
**Goal:** increase the probability that an eligible ticket reaches a correct, reviewable patch. Quality matters more than preserving the current prepare boundaries.

**Evidence convention:** claims marked **verified** are tied to source code, recorded artifacts, tests, or primary external documentation. Items under **proposal** are design recommendations, not shipped behavior.

## Executive finding

The highest-risk gap is not only false refusal or provider waste. The current process can also accept contradictory evidence and can reach opposite prepare outcomes for the same ticket without recording that history as a durable decision record. The redesign must therefore optimize for both sides:
- reduce avoidable refusal, retry cost, and operator mistakes;
- prevent false acceptance and make every decision reproducible;
- verify the resulting patch independently on the recorded base.

The target outcome is **a reproducible patch applied to a known base and passing an independent verification harness**, not merely a stable `final.md`, a non-empty branch, or a successful model conversation.

## Incident facts, independently checked

### Same ticket, opposite prepare outcomes

For finance-hub #45:
- Batch `0012-multi-49-45` has `tickets/45/acceptance.json`, kind `code-fix`, 7 criteria, and an initial verifier block with 11 matching claim rows and matching DoD verdicts.
- Batch `0013-multi-49-45` has no acceptance or manifest. Its initial verifier block has 12 rows, mismatches `[3, 7, 8, 11, 12]`, and its repaired five-row table still mismatches local rows `[1, 2, 5]`, which map to original rows `[3, 7, 12]`.
- Both records are for the same repository and ticket. The triage reports differ in row count and sampled commands. The record set does not currently make the earlier acceptance/refusal relationship a first-class decision history.

Verify from the finance-hub checkout:

```sh
cd /Users/afshin/Documents/dev/finance-hub
jq '{ticket,kind,criteria:(.criteria|length)}' \
  mypi-tasks/000-batches/0012-multi-49-45/tickets/45/acceptance.json
jq '[.verdicts[] | select(.verdict == "mismatch") | .row]' \
  mypi-tasks/000-batches/0013-multi-49-45/tickets/45/verdicts.json
jq '[.verdicts[] | select(.verdict == "mismatch") | .row]' \
  mypi-tasks/000-batches/0013-multi-49-45/tickets/45/reverdicts.json
```

This is not proof that either model was irrational. It is proof that the decision is sample-dependent and that repeated prepare needs durable history, a fixed snapshot, and a reproducibility policy.

### One accepted match was supported by a broken command

Batch `0012` ticket #45 verifier row 10 is marked `match`, but its evidence says the command also reported `` `|` and `head` as missing files ``. The command had been mangled by shell parsing, yet acceptance did not apply a command-fidelity check to every matching row.

The current `commandFaults` detector checks control characters and unassigned variables at `src/batch/report.ts:142-161`. The acceptance path calls the detector only to decide whether a `harness-error` is repairable, at `src/batch/prepare.ts:700-729`; a row already marked `match` is not invalidated by a fidelity fault.

### A triage command is mangled by embedded backticks

In `0013` ticket #45, `parseTriageReport` retains inner backticks in row 12's command (`grep -n "verdicts:" …`; `gh issue view 43 …`). The verifier prompt wraps the command in another Markdown code span at `src/batch/prepare.ts:683` through `verifierPrompt`, so the verifier can run command substitution rather than the author's command. `commandFaults` does not detect backticks, `$(`, or nested command-substitution markers.

### The triage verdict column is annotation, not a gate

`parseClaims` stores the fourth cell at `src/batch/report.ts:185-191`; it does not validate or use it in `acceptance`. `src/batch/report.ts:414-445` evaluates the verifier block, not the triage row's `verdict`. Both 0012 and 0013 contain the same stale Map/#43 claim marked false in the triage report, while their verifier outcomes differ. That disagreement is currently invisible to the decision record.

A triage `false` or `partial` row must remain recordable: it describes a refuted or qualified claim and must not itself refuse the ticket. It also must not be citable as proof of a DoD criterion without independent verifier support.

### The earlier manifest-halt bug is fixed

Batch `0012/summary.json` records #49 as `manifest-invalid` and #45 as `batch-halted`. That was the pre-#439 behavior. `ff4cd74` changed `src/batch/executor.ts` to recognize `refusal.json` as `prepare-refused`, continue unrelated tickets, and block only dependents. The current source contains `prepare-refused` and reads `refusal.json` at `src/batch/executor.ts:160-184,575-635`.

Therefore the old statement that automation is blocked because a sibling refusal prevents an accepted ticket from running is stale. The redesign should retain a regression test for #439, not propose fixing it again.

## Current design, verified

| Area                 | Evidence                                                      | Current consequence                                                                                                                        |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Prepare ordering     | `src/batch/prepare.ts:612-780`; `docs/batch-guide.md:93-126`  | Verification and manifest preflight happen before tracker publication.                                                                     |
| Multi-pass intake    | `src/batch/prepare.ts:357-511,679-735`                        | Triage, verifier, bounded repair/re-verify, and per-site retries exist.                                                                    |
| Claim parsing        | `src/batch/report.ts:84-193`                                  | Markdown table shape is parsed, but required-cell semantics are weak.                                                                      |
| Fidelity detection   | `src/batch/report.ts:142-161`; `src/batch/prepare.ts:700-729` | ASCII/unset-variable faults are detected only after verifier output and only affect repair routing.                                        |
| Decision evidence    | `src/batch/prepare.ts:548-557`                                | Initial verifier and re-verifier blocks are separate files; merged final block is not persisted.                                           |
| Kind selection       | `src/batch/cli.ts:125-152`; `src/batch/request.ts:10-14`      | One global `--kind`; mixed-ticket kinds cannot be represented.                                                                             |
| Retry classification | `src/batch/prepare.ts:357-411`                                | Throws become `infra-error`; parse failures become `unverifiable`; this distinction already exists.                                        |
| Run success          | `src/batch/executor.ts:430-523`                               | A non-empty committed branch plus declared validation and stable runtime artifacts can produce success; clean-base patch replay is absent. |
| Run recovery         | `docs/batch-guide.md:170-171`                                 | No general resume; a retry is a new batch.                                                                                                 |
| Tracker writes       | `src/batch/tracker.ts`; `src/batch/prepare.ts:846-900`        | Marker comment and label calls are separate side effects.                                                                                  |

## Revised design recommendations

### 1. Make decisions reproducible and durable

**Proposal:** create a canonical per-ticket decision record keyed by repository, issue number, batch, and attempt. Persist:
- issue snapshot: title, body, labels, `updatedAt` and repository/base SHA;
- exact triage response and parsed claims/DoD;
- exact verifier response and parsed block;
- repair delta and re-verifier response;
- final merged verifier block used by acceptance;
- selected kind, model slugs, prompts or prompt hashes, costs, timestamps and outcome;
- a decision-history index showing prior attempts and whether each was accepted, refused, or superseded.

A repeated prepare should see prior decisions. Policy should then choose one explicit behavior: reuse a valid decision for the same snapshot, require an explicit re-prepare, or run a new attempt while preserving the old one. Never silently overwrite the only evidence.

**Evidence-pointer correction:** `flagged()` at `src/batch/report.ts:350-362` hardcodes `VERDICT_EVIDENCE`. `contradictionDetail()` at `:378-380` already accepts an evidence filename and passes `REVERDICT_EVIDENCE` for the re-verification case at `:577`. The smallest pointer-only fix is to pass the appropriate file into `flagged()`. The stronger fix is to persist the merged final block as authoritative evidence, so the refusal points to the decision it actually used.

### 2. Make `match` mean that the command ran as written

**Proposal:** run a deterministic fidelity check on every claim row before acceptance, not only on rows the verifier calls `could-not-run`. A fidelity failure voids that row's `match` and routes it through the existing repair/refusal policy.

Extend the existing detector, without moving #401's already-decided repair boundary, to detect at least:
- non-ASCII command abbreviations;
- unassigned variables;
- backticks;
- `$(` and nested command substitution;
- malformed/nested Markdown code spans introduced while embedding a command.

Preserve the verifier's first call: it identifies whether the target is absent or the command is at fault. The new rule is that a verifier `match` cannot survive a deterministic fidelity fault.

### 3. Add parser hygiene without rejecting legitimate annotations

**Proposal:** validate only structural hygiene before the semantic verifier:
- claim, command, observed, and verdict cells are non-empty;
- the **first token** of the triage verdict cell is `true`, `partial`, or `false` (case-insensitive), allowing annotations such as `true (current code; once an error listener is added bun does emit …)`;
- cheap proof-shape checks where mechanically decidable, such as an impossible cited line range.

Do not require strict equality for the whole verdict cell. The recorded `test/fixtures/batch/triage-200.txt` and the 0013 #45 report contain annotated verdict cells; strict equality would reject real reports and fail the existing recorded-report tests at `test/unit/batch-report.test.ts:183-200`.

The triage verdict remains record hygiene, not an acceptance gate: `false` and `partial` are expected claim results and must not refuse a ticket. A false/partial claim cannot serve as DoD evidence unless the verifier independently supports the criterion.

### 4. Make kind selection explicit, per-ticket, and auditable

**Proposal:** add a per-ticket kind mapping to `request.yaml`, reject conflicting CLI overrides, and record the selected kind in acceptance and refusal records, manifests, start output, and summaries. Also record why a pinned kind was selected when the operator overrides triage.

The current one-value CLI flag is verified at `src/batch/cli.ts:125-152`; the request type is batch-wide at `src/batch/request.ts:10-14`. A valid but wrong kind remains a semantic operator error unless the reason and selection are visible for review.

### 5. Add resumable state, but do not re-label existing error classes

**Proposal:** persist phase state and append-only events for `snapshot → triage → verify → repair → manifest → preflight → execute → patch-verify → publish`. Add leases, heartbeats, input/output hashes, idempotency keys and restart/resume.

The existing split is already verified: `attemptTwice` maps a thrown agent call to `infra-error` and a parse failure to `unverifiable` at `src/batch/prepare.ts:385-397`. The improvement is not inventing new basic classes; it is recording the next action for each class, preserving completed phases, and avoiding duplicate model calls and tracker writes after worker failure.

### 6. Verify the patch independently before success

**Proposal:** record a base SHA, export the candidate diff, apply it to a fresh checkout, and run the declared validation plus a minimal independent smoke suite. Record the patch hash, applied commit, test logs, and final result. This directly addresses false accepts that claim evidence is internally broken or that the branch is not reproducible.

This is the most important quality improvement beyond intake. A run can satisfy its local agents and still fail when applied cleanly to the intended base. Success should require this clean-checkout result, not only `final.md`, a commit, and the run's own validation.

### 7. Reconcile tracker side effects

**Proposal:** make comments/labels/check runs desired state with idempotency keys and reconciliation. A worker crash between separate GitHub calls should be recoverable from the local decision record. Use GitHub Check Runs for machine-readable prepare, execution, and patch-verification status; keep comments as human summaries.

### 8. Human escalation after repeated semantic mismatch

**Proposal:** after a bounded number of attempts for the same snapshot, stop paying the same repair loop and create an explicit `needs-human-review` outcome. Preserve all attempts. A triage/verifier disagreement should be visible in that record, not silently discarded.

## External patterns verified from primary sources

| Pattern                          | Primary source                                                                                                                                                                                     | Verified fact                                                                                                         | Useful design element                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| SWE-bench                        | [README](https://github.com/SWE-bench/SWE-bench), [paper](https://arxiv.org/abs/2310.06770)                                                                                                        | Tasks package issue text, repository/base commit, and tests; evaluation applies a generated patch and runs a harness. | Immutable snapshots, patch extraction, clean replay.          |
| SWE-agent                        | [repository](https://github.com/SWE-agent/SWE-agent)                                                                                                                                               | Trajectories are recorded and evaluated in a controlled checkout.                                                     | First-class tool traces and reproducible evaluation.          |
| OpenHands                        | [repository](https://github.com/All-Hands-AI/OpenHands)                                                                                                                                            | Runtime and evaluation concerns are separated.                                                                        | Stable task/evaluation API around the agent runtime.          |
| Temporal                         | [durable execution](https://docs.temporal.io/encyclopedia/durable-execution), [workflows](https://docs.temporal.io/workflows)                                                                      | Progress/history persist; activities can retry, timeout and resume.                                                   | Durable phases, leases and idempotent side effects.           |
| LangGraph                        | [durable execution](https://langchain-ai.github.io/langgraph/concepts/durable_execution/)                                                                                                          | Graph nodes checkpoint state and resume with idempotent side-effect guidance.                                         | A smaller graph-based alternative to Temporal.                |
| GitHub issue forms               | [syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues/using-issue-forms)                                                                                      | Typed required fields can be collected before an issue is opened.                                                     | Structured ticket inputs rather than prose-only extraction.   |
| GitHub Checks and merge queue    | [Checks API](https://docs.github.com/en/rest/checks/runs), [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges/configuring-pull-requests/managing-a-merge-queue) | Checks expose conclusions/annotations; merge queue validates a PR against the target branch.                          | Native machine-readable status and optional PR integration.   |
| JSON Schema / structured outputs | [JSON Schema](https://json-schema.org/specification), [OpenAI guide](https://platform.openai.com/docs/guides/structured-outputs)                                                                   | JSON Schema defines machine-checkable contracts; supported providers can constrain output to a schema.                | Versioned typed model boundaries with raw-response retention. |

## Options and recommendation

### Option A — Incremental hardening

Keep the local driver and add typed contracts, decision history, fidelity-on-match, per-ticket kinds, patch replay, tracker reconciliation, and check runs. Lowest migration risk; still a bespoke controller.

### Option B — Durable workflow controller

Implement the phases above with a file-backed append-only event log first, then evaluate Temporal or LangGraph when concurrent workers, long waits, or cross-host recovery justify the operational cost. This is the recommended target because it addresses repeated decisions and worker loss directly.

### Option C — Queue/worker service

Use GitHub events or Actions to enqueue tickets and leased workers to claim them. This improves throughput but adds service credentials, duplicate delivery, lease correctness, and operational dependency.

### Option D — PR-first loop

After clean patch verification, open a PR and let Checks and merge queue validate integration. This is the strongest native integration path, but changes the current branch-only workflow and needs repository policy decisions.

**Recommendation:** implement Option A's quality controls first, then converge on Option B. Add Option D once clean patch replay is reliable. Do not make provider retries, strict parser checks, or the prepare gate substitutes for reproducibility.

## Phased rollout, ordered for quality

| Phase                                            | Deliverables                                                                                                                                                                        | Exit criteria                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 0. Decision and evidence integrity               | Persist snapshots, attempt history, merged verifier block, triage/verifier disagreement, correct evidence pointers, and refusal kind.                                               | Re-preparing one ticket cannot erase or hide a prior decision; post-repair refusal points to the final evidence.        |
| 1. Fidelity and parser safety                    | Run command-fidelity checks on every row before acceptance; add backtick/`$(`/nested-span tests; add empty-cell and first-token verdict checks; preserve false/partial annotations. | A broken command cannot receive `match`; existing annotated fixtures still parse; false/partial rows remain recordable. |
| 2. Typed contracts and kind safety               | Versioned JSON schemas for triage/verifier/repair/outcome; per-ticket kind map with conflict checks and reason recording.                                                           | Malformed model output cannot publish; mixed-ticket batch choices are explicit and auditable.                           |
| 3. Patch harness                                 | Base SHA, diff export, clean-checkout apply, declared checks, smoke tests, patch/test artifacts.                                                                                    | Synthetic missing-commit, stale-base, broken-command and regression cases fail before success.                          |
| 4. Durable resume and side-effect reconciliation | Append-only events, leases, heartbeat, restart/resume, idempotent tracker reconciliation, GitHub Check Runs.                                                                        | Kill at each phase and resume without duplicate model spend or conflicting tracker state.                               |
| 5. Optional PR/queue integration                 | PR creation, Checks, merge queue.                                                                                                                                                   | Ticket-to-PR succeeds under branch protection; local branch-only mode remains supported.                                |

## Quality invariants to enforce

1. A triage `false` or `partial` is an annotation, not a refusal; it cannot be used as DoD proof without verifier support.
2. A verifier `match` is invalid if its command did not run exactly as written.
3. The merged verifier block used for the final decision is persisted and is the evidence a refusal names.
4. Every prepare attempt is keyed to a ticket/source snapshot and remains visible after re-prepare.
5. Every accepted kind is per-ticket, recorded, and attributable to either triage or an explicit operator reason.
6. A run is successful only after a clean-checkout patch replay on the recorded base passes.
7. A worker restart cannot duplicate a completed model phase or external tracker side effect.

## Independent verification commands

Driver repository:

```sh
cd /Users/afshin/Documents/dev/multi-agent
bunx vitest run test/unit/batch-report.test.ts test/unit/batch-prepare.test.ts
rg -n 'commandFaults|dialectFaults|flagged\(|contradictionDetail|parseClaims|acceptance\(' src/batch/report.ts src/batch/prepare.ts
rg -n 'kindAt|--kind|BatchRequest|prepare\(' src/batch/cli.ts src/batch/request.ts src/batch/prepare.ts
```

Finance-hub incident records:

```sh
cd /Users/afshin/Documents/dev/finance-hub
jq '{ticket,kind,criteria:(.criteria|length)}' mypi-tasks/000-batches/0012-multi-49-45/tickets/45/acceptance.json
jq '[.verdicts[] | select(.verdict == "mismatch") | .row]' mypi-tasks/000-batches/0013-multi-49-45/tickets/45/verdicts.json
jq '[.verdicts[] | select(.verdict == "mismatch") | .row]' mypi-tasks/000-batches/0013-multi-49-45/tickets/45/reverdicts.json
```

## Status

This document records verified findings and proposed redesign work. No production behavior should be treated as changed until code, tests, and artifacts prove the corresponding invariant.
