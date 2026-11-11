# Prepare speed: evidence, decisions, and next work

## Finding

One local `prepare` sample, ticket #414 on 2026-11-06, recorded **412.8 seconds of paid model-call time** across triage, verifier, repair, and re-verification. Triage was 354.6 seconds, about 86% of that recorded call time. This shows where model-call time went in this sample; it does **not** establish why triage took that long or how much time any prompt change will save.

This is one ticket, not a general baseline. The record has no per-call turn or token counts. The 412.8 seconds is the sum of recorded agent-call durations, not total `prepare` wall time: the prepare deadline starts after the repository clone, and other local or tracker work is not included in those call durations (`src/batch/prepare.ts`, `verifyTicket`).

## Evidence from the sample

These values come from local batch artifacts for ticket #414; raw artifacts may not be present in another checkout.

| Measurement                         |                                      Observed |
| ----------------------------------- | --------------------------------------------: |
| Triage call duration                |                                    354,582 ms |
| Verifier call duration              |                                     41,616 ms |
| Repair call duration                |                                     10,143 ms |
| Re-verification call duration       |                                      6,480 ms |
| Sum of the four paid-call durations |                         412,821 ms (6.88 min) |
| Recorded prepare cost               |                                      $0.08796 |
| Triage report                       | 11 claim rows, 12 shell commands, 6,143 bytes |
| Run duration and cost               |                  917,272 ms (15.3 min), $0.48 |

The earlier count of 10 claim rows was wrong; parsing the recorded report yields 11. The standalone triage experiments in `docs/explorations/triage-automation/triage-loop-brief.md` do not measure batch prepares and cannot estimate this sample's turns or tokens.

## What the code establishes

- `collectReply` retains assistant reply text and cost, not turn counts or token usage (`src/batch/agent.ts`). Pi's JSONL format includes `turn_end` events and cumulative provider-reported usage, which may be absent or zero (`pi` `docs/json.md`). Batch records currently retain per-site durations, not token or turn metrics (`src/batch/prepare.ts`).
- The triage prompt asks for claim checks, a Definition of Done, Need/Fix/Open-questions prose, and a verdict (`docs/explorations/triage-automation/triage-prompt.md`). The parser consumes claim rows, criteria, verdict, and kind (`src/batch/report.ts`). When the issue body supplies the DoD, prepare replaces the reply's criteria with the body's criteria before verification and manifest construction (`src/batch/prepare.ts`).
- The verifier receives the claim table and criteria, not the issue body or triage's Need/Fix reasoning (`src/batch/prepare.ts`). It re-runs claim commands and checks criteria against the tree and verified claims (`docs/explorations/triage-automation/triage-verifier.md`, `src/batch/report.ts`). It cannot replace triage's issue-scope and reachability judgment.
- The complete triage reply is saved as `report.md` in the local attempt record. Sections the parser does not consume remain available as human-readable evidence. It is too strong to call them “work no downstream consumer reads.”
- A later prepare can reuse a parseable triage reply only when both the issue-body hash and clone base revision match. The verifier still runs (`src/batch/prepare.ts`, `reusableReport` and `verifyTicket`). This is an existing way to avoid repeating triage for an unchanged ticket and tree.

## A1–A5 decisions

### A1 — Add per-attempt telemetry (next implementation)

Record aggregate metrics for each paid-call attempt, grouped by site and attempt: `turn_end` count, provider-reported input/output tokens when available, cost, and duration. Keep retries distinct. A site not called or reused must not look like a zero-duration or zero-token call; distinguish unavailable usage from a reported zero. Do not store raw prompts, tool arguments, or command output for this telemetry. Preserve existing acceptance/refusal behavior and record fields.

A1 is instrumentation, not a speedup. It should let later comparisons identify whether changes affect turns, tokens, cost, or duration. Test retries and absent-versus-zero values.

### A2 — Conditional context reads (implemented; impact unmeasured)

Merged in #510 (`5ab0c5e`). The shared triage prompt now says to consult target-repository guidance only when it exists and is relevant, and to skip missing optional references without treating their absence as a finding or blocker. This fixes the unconditional-read instruction for repositories such as finance-hub, where two named references were absent.

The prompt test proves the rendered instruction is present. It does not prove that A2 reduces elapsed time, tokens, or turns. No speed gain has been measured.

### A3 — Reduce redundant output only after preserving useful judgments

For body-owned DoDs, prepare uses the ticket body's criteria; triage need not author replacement criteria. A future prompt change may reduce duplicated criteria authoring and repeated tree checks, but must retain triage's assessment of scope, coverage, and whether the proposed fix reaches the reported mechanism. Keep concise Need/Fix/refusal reasoning useful to a human inspecting `report.md`, especially on refusals. Keep the verifier's criteria check unchanged.

Evaluate a revised prompt on fixed cases before adopting it. Do not delete a section solely because the parser does not consume it: the full reply is retained as evidence.

### A4 — Thinking-level configuration (deferred)

Do not add a production knob or lower the default based on the #414 timing. Pi supports `--thinking`, but batch model preflight resolves model slugs and does not establish that a selected thinking level is supported by each model (`src/batch/agent.ts`, `src/batch/preflight.ts`). Any future experiment must compare time and cost as well as decision quality, including verifier calibration, before changing defaults.

### A5 — Do not remove triage's DoD review wholesale

The verifier independently checks criteria against the tree and verified claims, but does not receive the issue body. Triage must still decide whether the criteria cover the request and whether the proposed change can reach the reported mechanism. Removing triage's entire step-5 review is not justified. A narrower reduction of duplicate tree-level checks could be tested while preserving triage's issue-level judgments and the verifier gate.

## Plan

1. **Implement A1 telemetry without changing gates.** This provides comparable measurements; it is not a prerequisite for keeping the already-merged A2 correction.
2. **Evaluate A2 and any proposed A3 edit with the verifier unchanged.** Use fixed issue/tree inputs covering a false claim, an off-path fix, a body-owned DoD, and a valid no-DoD refusal. Compare old and new triage prompts; independently verify claims and have a human compare scope, reachability, and refusal decisions. Report elapsed time, tokens, cost, turns, and decision differences. Do not adopt A3 if it loses a correct refusal or useful issue-level judgment.
3. **Keep A4 deferred.** Reconsider only with measurements and a quality comparison.
4. **Keep the separate claim verifier and all claim rows.** Removing or sampling verification weakens the trust boundary; the single timing sample gives no evidence that this trade is warranted.

## Reproduce the recorded sample

From a checkout containing the local, ignored artifacts:

```sh
jq '{durations, costUsd}' mypi-tasks/000-batches/0012-docs-414/tickets/414/acceptance.json
jq '{durationMs, costUsd}' mypi-tasks/000-batches/0012-docs-414/tickets/414/run.json
```

The corresponding triage reply is at `mypi-tasks/000-batches/0012-docs-414/tickets/414/report.md`. These are local run artifacts, not committed source files.
