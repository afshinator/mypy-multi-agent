# Batch automation findings: prepare failures and prevention

**Date:** 2026-11-08  
**Scope:** finance-hub batches `0012-multi-49-45` and `0013-multi-49-45`, plus the batch driver on `main`
**Purpose:** preserve independently checkable findings from the failed prepare attempt. This is a research record, not a claim that the proposed mitigations have been implemented.
**Re-verified:** 2026-11-09 against `main` at `c4c838e`. Findings 1-4 still hold; line citations below are the current tree's, and the two behaviour changes found are recorded under "Re-verification".

## Executive conclusion

The failed prepare was not one generic "multi-agent failure." It exposed four actionable weaknesses and one already-fixed execution bug:
1. A model-produced triage report can contain commands and observations that are structurally parseable but factually wrong or stale.
2. The same ticket received opposite prepare outcomes in two recorded attempts, with different reports and verifier decisions. The artifacts do not establish whether the cause was triage-sample variance, verifier-judgement variance, or both; the system does not yet make that decision history or reproducibility policy explicit.
3. Accepted evidence can contain a row marked `match` even when the command output shows shell mangling, and triage/verifier disagreement is not recorded as a first-class signal.
4. The CLI accepts one global `--kind`, which allowed the operator to select `code-small` for both tickets even though the intended templates differed (`#49` code-small, `#45` code-fix).

The historical execution blocker in batch `0012` was #439: a refused sibling was misclassified as `manifest-invalid` and halted accepted #45. That bug was fixed in `ff4cd74`; current `runBatch` records `prepare-refused` and continues unrelated tickets (`src/batch/executor.ts:556-604`). Batch `0013` instead failed at prepare, so the current automation problem is decision reproducibility and evidence quality, not the old sibling-halt path.

## Re-verification (2026-11-09)

All four findings replay against the current tree. Two things changed after this record was written:
1. **#424 closed the accepted-to-refused flip, not the reproducibility gap.** An existing `acceptance.json` or `run.json` now ends prepare as `already-prepared` before any model call (`src/batch/prepare.ts:586-593`, `docs/batch-guide.md:66-68`), so re-preparing an accepted ticket spends nothing and cannot flip it. The gap that remains is on a refused ticket: a later prepare still takes a fresh triage sample with no recorded link to the earlier report, so refused-to-accepted variance is still unmeasurable. The `acceptance.json` guard inside the refusal branch of `prepare` (`src/batch/prepare.ts:851`) is now reachable only by a concurrent prepare (#427, open).
2. **`request.yaml`'s batch-level `kind` is dead.** `src/batch/request.ts:12-14` parses, validates and writes it, but nothing reads it: `verifyTicket` pins only the CLI `--kind` (`src/batch/prepare.ts:671`). Finding 3 is therefore stronger than recorded, not weaker — the CLI flag is the only selection path, and it is still one value for the whole batch.

The remaining defect claims were re-read directly: the merged post-repair block is still not persisted and `flagged()` still points every refusal at `verdicts.json`; empty claim cells and first-token verdict shape are still unchecked; the verifier reply still carries no command or exit status per row (`RowVerdict` is `{row, verdict, evidence}` at `src/batch/report.ts:38-42`); criteria still do not cite claim rows.

## Incident record

The run was prepared with:

```sh
cd /Users/afshin/Documents/dev/finance-hub
bun /Users/afshin/Documents/dev/multi-agent/src/batch/cli.ts \
  prepare 0013-multi-49-45 --kind code-small
```

The command selected one kind for the whole batch. The resulting records are outside this repository at:

```text
/Users/afshin/Documents/dev/finance-hub/mypi-tasks/000-batches/0013-multi-49-45/
```

Inspect the raw evidence with:

```sh
cd /Users/afshin/Documents/dev/finance-hub
find mypi-tasks/000-batches/0013-multi-49-45 -maxdepth 3 -type f -print | sort
cat mypi-tasks/000-batches/0013-multi-49-45/tickets/49/refusal.json
cat mypi-tasks/000-batches/0013-multi-49-45/tickets/45/refusal.json
```

Observed outcomes:

| ticket | result              | evidence                                                                                                                                                                                                                                               |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #49    | `infra-error`       | `tickets/49/retries.json` records a triage connection error followed by a repair timeout; `refusal.json` says `pi timed out after 300000 ms`.                                                                                                          |
| #45    | `verifier-mismatch` | The initial `tickets/45/verdicts.json` mismatched rows 3, 7, 8, 11, and 12. Repair covered those five rows; `reverdicts.json` used local rows 1, 2, and 5 for original rows 3, 7, and 12, so rows 8 and 11 were fixed while 3, 7, and 12 still failed. |

Neither ticket received `acceptance.json` or `manifest.yaml`; therefore no implementation agent should have run.

### Evidence-pointer defect exposed by this incident

The refusal detail says `mismatch on rows 3, 7, 12 — see verdicts.json`, but that pointer is incomplete after repair. `src/batch/prepare.ts:699` stores the initial verifier block in `evidence.verdicts`; `:504-507` stores the later re-verification separately; and `:548-562` writes those blocks to `verdicts.json` and `reverdicts.json`. The merged post-repair block used for the final decision is not persisted. Specifically, `flagged()` at `src/batch/report.ts:350-361` hardcodes `VERDICT_EVIDENCE`; `contradictionDetail()` at `:378-380` already accepts an evidence filename and passes `REVERDICT_EVIDENCE` at `:577` for re-verification contradictions. A pointer-only fix should change `flagged()` to accept the appropriate evidence filename; the stronger fix persists the merged final block as authoritative evidence.

### Cross-attempt reproducibility gap

The two records prove a flip, not its cause. Batch `0012` accepted #45 with an 11-row report and no claim or DoD mismatches; batch `0013` refused #45 after a 12-row report whose initial mismatches were `[3, 7, 8, 11, 12]` and whose repaired-table mismatches mapped to `[3, 7, 12]`. Each verifier checked the report generated in its own attempt. Nothing in these artifacts separates triage-sample variance from verifier-judgement variance. To measure verifier variance, the system must retain a report and its snapshot/base identity, then re-run that same report under the same conditions; a ticket-only history cannot answer that question. #424 has since removed one direction of the flip — an accepted ticket can no longer be re-prepared at all — but a refused ticket's next attempt still leaves no report identity to compare against, so neither variance is measurable yet.

Verify the recorded row sets:

```sh
jq '[.verdicts[] | select(.verdict == "mismatch") | .row]' mypi-tasks/000-batches/0013-multi-49-45/tickets/45/verdicts.json
# [3, 7, 8, 11, 12]
jq '[.verdicts[] | select(.verdict == "mismatch") | .row]' mypi-tasks/000-batches/0013-multi-49-45/tickets/45/reverdicts.json
# [1, 2, 5]  (repair-table positions for original rows 3, 7, 12)
```

## Finding 1 — triage output is not fully mechanically linted

### Verified claim

The report parser validates the Markdown table shape and the verifier later checks the published commands, but the parser does not establish that every claim cell is meaningful or that the shell command is semantically valid.

### Evidence

- `src/batch/report.ts:88-113` splits table rows and `:179-183` rejects ragged rows.
- `src/batch/report.ts:165-194` creates claim rows from the four cells; the structural parser does not reject empty claim, observed, or verdict cells.
- `src/batch/report.ts:142-157` only detects non-ASCII/control characters and references to unset shell variables. It does not parse shell syntax, validate line ranges, or prove that a command's output supports the claim.
- `src/batch/report.ts:119-122` removes backticks only when the entire cell is one code span. A command containing multiple spans therefore keeps its backticks; the detector then sees only printable ASCII and assigned-variable patterns.
- The prompt requires a command behind every claim at `docs/explorations/triage-automation/triage-prompt.md` in the `WHAT IS TRUE` and output sections, but prompt text is not enforcement.
- `test/unit/batch-report.test.ts:183-202` checks that recorded fixture commands are non-empty; it does not prove that all required cells are non-empty or that commands are executable.
- The independent verifier is deliberately the semantic check: `src/batch/prepare.ts:679-735` runs it, applies `acceptance`, and can enter the repair round.

### Incident evidence

#45's original verifier artifact (`.../tickets/45/verdicts.json`) rejected claim rows 3, 7, 8, 11, and 12. The repair artifact (`.../tickets/45/repair.md`) covered those five rows. Its five-row re-verification is stored separately in `reverdicts.json`; local rows 1, 2, and 5 map back to original rows 3, 7, and 12, while original rows 8 and 11 were fixed. The verifier marked row 4 `match`; row 4's `false` annotation came from triage's own report column, not the verifier. The verifier did catch the stale/false claims represented by rows 7 and 12 in the failed attempt.

The accepted 0012 record also demonstrates the false-accept evidence problem. Its `verdicts.json` row 10 is `match`, while the evidence it records reports a mangled run:

```text
Output shows verdicts: Verdict[] in both files; grep also reported `|` and `head` as missing files.
```

The same shape appears in 0013, where row 5 is `match` and the evidence reports that the escaped pipe also caused grep errors:

```text
Output included the descriptor fields on lines 41–44; the escaped pipe also caused grep errors.
```

Both stored commands parse clean, so the mangling is in the verifier's run, not in the command the driver stored. A different defect is 0013 row 12's parsed command, the two-span command `` `grep -n "verdicts:" …`; `gh issue view 43 …` `` from `report.md`: `unwrap()` at `src/batch/report.ts:119-122` strips only a whole-cell span, so the embedded delimiters remain and `commandFaults()` does not flag them.

### Preventive action

The recommendation here is narrower than an additional command-dialect detector. **#401 already decided and implemented that layer**: `commandFaults` and `dialectFaults` live at `src/batch/report.ts:142-165`, and `src/batch/prepare.ts:703-727` uses them to route an all-dialect `harness-error` into the bounded repair round. That design intentionally spends the first verifier call to identify which rows are actually unrun; moving it earlier would reverse a decision already taken without new evidence.

The remaining structural gap is different. Add deterministic parser validation for:
- empty claim, command, observed, or verdict cells;
- a verdict cell whose **first token** is not `true`, `partial`, or `false` (case-insensitive), while preserving annotations such as `true (current code; ...)`;
- cheap proof-shape errors that can be established without semantic investigation, such as a cited line range that cannot contain the cited symbol.

This is record hygiene, not a refusal condition for a claim: `false` and `partial` are legitimate triage findings and must remain recordable. The current criteria do not cite claim-row numbers, so the statement that a false/partial claim cannot support a criterion is not enforceable as written. Make the link explicit: require each criterion to cite the claim rows it rests on, then deterministically reject a criterion that cites any row the verifier did not mark `match`. Strict whole-cell equality would reject the annotated `test/fixtures/batch/triage-200.txt` report and annotated rows in the recorded #45 report.

This validation can return `unverifiable` before the semantic verifier spends money. It must not replace the verifier: factual truth and whether output supports a claim remain semantic judgments. Unsafe evidence targets and absolute paths are a separate policy decision; the guide records that claims can escape the clone at `docs/batch-guide.md:271-275`, but this document does not claim a complete path policy has been designed.

## Finding 2 — tickets can be stale or factually imperfect

### Verified claim

The ticket itself is not treated as truth. Triage investigates it, and a second model re-runs its claim commands. Stale claims are expected to be rejected rather than silently turned into work.

### Evidence

- The triage prompt says issue file, line, incident, and behavior claims remain claims until a command verifies them: `docs/explorations/triage-automation/triage-prompt.md`, `SITUATION` and `WHAT IS TRUE`.
- The verifier prompt requires re-running each published command and marks non-reproducing output as `mismatch`: `docs/explorations/triage-automation/triage-verifier.md`, `FUNCTION AND ARTIFACT`.
- `src/batch/prepare.ts:679-735` applies verifier shape checks, mismatches, and DoD verdicts before accepting (`acceptance` itself is `src/batch/report.ts:414-444`).
- For #45, the raw triage report (`.../tickets/45/report.md`) itself marked the "first RSC page" claim false, while the verifier marked that row `match`; the verifier's failed attempt identified rows 7 and 12 as mismatches, including the stale #43/`Map` claim. The triage and verifier disagree, and that disagreement is currently not recorded as a first-class signal.

### Boundary

This is an input-quality problem, not evidence that the prepare gate is wrong. Removing or weakening the verifier would turn stale ticket prose into runnable work. The useful automation goal is better diagnosis and cheaper recovery, not unconditional acceptance.

### Preventive action

- Keep the verifier fail-closed.
- Make refusal artifacts and failure classes easier to read as human-actionable results.
- Consider a bounded human-review path for repeated `verifier-mismatch` results rather than repeatedly paying the same repair loop.
- Do not allow repair to rewrite the Definition of Done silently. The current repair is intentionally limited to command/observed cells at `src/batch/prepare.ts:419-478`; expanding it would need a separate, explicit contract because changing the claim itself changes the basis of acceptance.
- Fix the post-repair evidence pointer: either persist the merged final block as authoritative evidence or make a refusal detail name both `verdicts.json` (initial block) and `reverdicts.json` (repair result). The current code writes the merged decision nowhere, so `see verdicts.json` cannot by itself explain a post-repair refusal.

## Finding 3 — one global kind flag permits an operator mismatch

### Verified claim

The CLI accepts one optional `--kind` and passes it to every ticket in the request. It cannot express different kinds for different tickets in one batch.

### Evidence

- `src/batch/cli.ts:126-156` parses one `--kind` value and passes it once to `prepare`, which applies it to every ticket.
- `src/batch/request.ts:12-14` has one optional batch-level `kind`, not a per-ticket mapping. Nothing reads it: `verifyTicket` takes the CLI pin and otherwise the triage's `KIND:`, so the field is parsed, validated and written, then ignored.
- `src/batch/prepare.ts:671` uses the pinned kind for the ticket and suppresses triage classification when pinned.
- `src/batch/prepare.ts:739-767` selects and preflights the resulting kind's template.
- The recorded operator command above used `--kind code-small` for a batch containing #49 and #45. The intended selection was #49=`code-small`, #45=`code-fix`, so the interface could not represent the intended plan safely.

### Preventive action

Choose and test one explicit design:
1. Add per-ticket kind mappings to `request.yaml` and reject a conflicting CLI override.
2. Or reject `--kind` for multi-ticket requests unless every ticket is intentionally the same kind.
3. Or accept repeated ticket-specific flags such as `--kind 49=code-small --kind 45=code-fix`, with strict validation and a recorded mapping.

Whichever design is chosen, the generated acceptance record, manifest, start block, and summary must show the selected kind per ticket. A valid but wrong kind is not detectable from the current schema, so silently trusting the operator is the defect.

## Finding 4 — the prepare gate is the correct automation boundary

### Verified claim

Prepare deliberately verifies the issue and produces a manifest before comments, labels, or implementation runs. A failed prepare should not produce a runnable ticket.

### Evidence

- `src/batch/prepare.ts:610-647` bounds each model call and distinguishes provider/timeout errors from ticket verdicts.
- `src/batch/prepare.ts:649-702` runs triage, parses it, then runs the independent verifier.
- `src/batch/prepare.ts:703-735` rejects mismatches and only proceeds after the verifier accepts.
- `src/batch/prepare.ts:738-780` builds and preflights the manifest only after acceptance.
- `docs/batch-guide.md:62-128` documents the order: verify, build/preflight, then write the record/comment and add `ready-for-agent`.
- ADR 0004 states why this must happen outside the runtime: `docs/adr/0004-batch-driver-outside-the-runtime.md:5-13`. The runtime has no tracker tool and cannot fetch its own ticket.

### Consequence

The gate correctly prevented #49 and #45 from receiving manifests. #49 failed because the model/provider path did not complete; #45 failed because its evidence did not survive independent checking. These are different failure classes and should not be reported as one generic "ticket rejected" result.

### Preventive action

Keep the gate, but improve recoverability:
- persist stage-level evidence and a resumable prepare state so a provider failure does not require repeating already-valid triage;
- preserve the existing codes and details: `attemptTwice()` maps a thrown call to `infra-error` and a parse failure to `unverifiable` at `src/batch/prepare.ts:363-411`; a verifier mismatch follows the separate `repairRound()` path at `:419-511`;
- add operator guidance that maps each existing class to its next action, rather than inventing a nonexistent `provider-error` code or treating all retries as the same shape;
- add an explicit human-review outcome after repeated semantic mismatches.

The current retry mechanism is bounded and in-process: `src/batch/prepare.ts:363-411` retries a paid call, and `src/batch/prepare.ts:419-511` performs one claim-row repair round. It does not resume a completed stage in a later command. The repair round is not resumable prepare state: it only runs inside one invocation and only changes claim `command`/`observed` cells.

## Recommended order of work

1. **Make decisions reproducible and recorded.** Persist the ticket/source snapshot, each prepare attempt, the triage/verifier disagreement, and the merged verifier block used for the final decision. Key the decision history to the report/snapshot identity, not only the ticket, so a later re-run can distinguish a new triage sample from a verifier re-run of the same report. Make re-prepare behavior explicit so the same ticket cannot flip silently between accepted and refused without visible history.
2. **Make `match` mean the command ran as written.** Two remedies, because the two recorded cases fail differently. Driver-side: extend the existing fidelity check to a backslash-escaped or literal pipe in a table cell, backticks, `$(`, and two-span cells, then invalidate any verifier `match` carrying a fidelity fault; that covers 0013 row 12's retained backticks. Verifier-side: a `match` whose own evidence reports a shell or tool error is not a match, which is where 0012 row 10 and 0013 row 5 sit — their stored commands parse clean, so no check on the row can catch them, and deciding it deterministically needs the verifier reply to carry the command it ran and its exit status for each row. Keep #401's first verifier call and repair boundary unchanged.
3. **Add claim-table structural hygiene.** Reject empty cells and use a first-token verdict check; preserve annotated `true`, `partial`, and `false` findings. Add cheap proof-shape checks without treating false/partial triage annotations as ticket refusals. Do not duplicate #401's command-dialect detector.
4. **Make kind selection explicit and auditable.** Add per-ticket kind selection or reject mixed-ticket use of `--kind`; record the selected kind and the operator's override reason in acceptance/refusal records, manifests, start output, and summaries.
5. **Add resumable prepare state and operator-facing recovery.** Preserve completed phases and stage costs across provider failures; do not reuse state after the ticket or source revision changes. Keep existing `infra-error`/`unverifiable` distinctions, but map each class to a next action and escalate repeated semantic mismatches to human review.
6. **Add end-to-end quality tests.** Cover the #439 fixed behavior, post-repair evidence pointers, fidelity-invalid matches, triage/verifier disagreement recording, and the new criterion-to-claim-row references. Extend the existing publication-order/refusal tests in `test/unit/batch-prepare.test.ts:171-193` and its refusal cases; do not treat that already-covered publication boundary as new work. An accepted ticket must have a manifest and matching tracker state; a refused ticket must have no manifest or ready label.

## Independent verification commands

From the driver repository:

```sh
cd /Users/afshin/Documents/dev/multi-agent
bunx vitest run test/unit/batch-report.test.ts test/unit/batch-prepare.test.ts
rg -n 'kindAt|--kind|prepare\(' src/batch/cli.ts src/batch/request.ts src/batch/prepare.ts
rg -n 'verifierAttempt|acceptance\(|writeEvidence|ready-for-agent' src/batch/prepare.ts
rg -n 'could-not-run|mismatch|re-ask|absolute path|growing log' docs/explorations/triage-automation docs/batch-guide.md
```

From the finance-hub checkout, to verify this incident's raw evidence:

```sh
cd /Users/afshin/Documents/dev/finance-hub
cat mypi-tasks/000-batches/0013-multi-49-45/tickets/49/refusal.json
cat mypi-tasks/000-batches/0013-multi-49-45/tickets/49/retries.json
cat mypi-tasks/000-batches/0013-multi-49-45/tickets/45/refusal.json
cat mypi-tasks/000-batches/0013-multi-49-45/tickets/45/verdicts.json
cat mypi-tasks/000-batches/0013-multi-49-45/tickets/45/repair.md
cat mypi-tasks/000-batches/0013-multi-49-45/tickets/45/reverdicts.json
```

The document's claims about #45 can be independently checked from the two JSON files: the initial
mismatch set is `[3, 7, 8, 11, 12]`; the repaired-table mismatch set is `[1, 2, 5]`, corresponding to
original rows `[3, 7, 12]`.

## Status

- This document records findings and recommendations only.
- No production changes are made by this document.
- Re-verified 2026-11-09 against `c4c838e`: findings unchanged, citations updated, #424's `already-prepared` guard and the unused `request.kind` added.
- No recommendation above should be treated as implemented until its code, tests, and documentation are landed and independently verified.
