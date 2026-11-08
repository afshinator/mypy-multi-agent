# Batch automation findings: prepare failures and prevention

**Date:** 2026-11-08  
**Scope:** finance-hub batch `0013-multi-49-45` and the batch driver on `main`  
**Purpose:** preserve independently checkable findings from the failed prepare attempt. This is a research record, not a claim that the proposed mitigations have been implemented.

## Executive conclusion

The failed prepare was not one generic "multi-agent failure." It exposed three actionable weaknesses and one correct safety behavior:
1. A model-produced triage report can contain commands and observations that are structurally parseable but factually wrong or stale.
2. The ticket source can contain stale or false assertions. The verifier correctly rejects them; this is expected input handling, not a reason to remove the gate.
3. The CLI accepts one global `--kind`, which allowed the operator to select `code-small` for both tickets even though the intended templates differed (`#49` code-small, `#45` code-fix).
4. The prepare gate correctly refused both tickets before publishing runnable manifests. A transient provider failure affected #49; unverifiable evidence affected #45.

Automation is blocked because a ticket is not converted into a manifest until its claims and Definition of Done survive independent verification. The correct response is to reduce avoidable failures around that boundary, not to bypass it.

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

| ticket | result              | evidence                                                                                                                                      |
| ------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| #49    | `infra-error`       | `tickets/49/retries.json` records a triage connection error followed by a repair timeout; `refusal.json` says `pi timed out after 300000 ms`. |
| #45    | `verifier-mismatch` | `tickets/45/verdicts.json` records mismatches on rows 3, 7, and 12; the repair and re-verification artifacts preserve the failed correction.  |

Neither ticket received `acceptance.json` or `manifest.yaml`; therefore no implementation agent should have run.

## Finding 1 — triage output is not fully mechanically linted

### Verified claim

The report parser validates the Markdown table shape and the verifier later checks the published commands, but the parser does not establish that every claim cell is meaningful or that the shell command is semantically valid.

### Evidence

- `src/batch/report.ts:84-114` splits table rows and rejects ragged rows.
- `src/batch/report.ts:165-193` creates claim rows from the four cells; the structural parser does not reject empty claim, observed, or verdict cells.
- `src/batch/report.ts:142-161` only detects non-ASCII/control characters and references to unset shell variables. It does not parse shell syntax, validate line ranges, or prove that a command's output supports the claim.
- The prompt requires a command behind every claim at `docs/explorations/triage-automation/triage-prompt.md` in the `WHAT IS TRUE` and output sections, but prompt text is not enforcement.
- `test/unit/batch-report.test.ts:183-200` checks that recorded fixture commands are non-empty; it does not prove that all required cells are non-empty or that commands are executable.
- The independent verifier is deliberately the semantic check: `src/batch/prepare.ts:679-735` runs it, applies `acceptance`, and can enter the repair round.

### Incident evidence

#45's original verifier artifact (`.../tickets/45/verdicts.json`) rejected claim rows 3, 7, and 12. The repair artifact (`.../tickets/45/repair.md`) changed commands and observations, but re-verification still rejected rows. This is consistent with the verifier catching claims that the parser can represent.

### Preventive action

Add a deterministic pre-verifier lint layer for:
- empty claim, command, observed, and verdict cells;
- verdict values outside `true | partial | false`;
- commands with shell syntax known to be impossible for the configured shell;
- unsafe or unverifiable evidence targets, especially absolute paths outside the prepared clone;
- obviously impossible proof forms such as a cited line range that excludes the cited symbol, where a cheap static check can prove it.

This should return a distinct `unverifiable`/harness reason before spending the semantic verifier. It must not replace the verifier: factual truth and whether output supports a claim remain semantic judgments.

## Finding 2 — tickets can be stale or factually imperfect

### Verified claim

The ticket itself is not treated as truth. Triage investigates it, and a second model re-runs its claim commands. Stale claims are expected to be rejected rather than silently turned into work.

### Evidence

- The triage prompt says issue file, line, incident, and behavior claims remain claims until a command verifies them: `docs/explorations/triage-automation/triage-prompt.md`, `SITUATION` and `WHAT IS TRUE`.
- The verifier prompt requires re-running each published command and marks non-reproducing output as `mismatch`: `docs/explorations/triage-automation/triage-verifier.md`, `FUNCTION AND ARTIFACT`.
- `src/batch/prepare.ts:679-735` applies verifier shape checks, mismatches, and DoD verdicts before accepting.
- For #45, the raw triage report (`.../tickets/45/report.md`) claimed that this was the repository's first RSC page, that no print CSS existed anywhere, and that portfolio components still used a `Map` while #43 was already closed. The verifier artifact identified those as false or stale.

### Boundary

This is an input-quality problem, not evidence that the prepare gate is wrong. Removing or weakening the verifier would turn stale ticket prose into runnable work. The useful automation goal is better diagnosis and cheaper recovery, not unconditional acceptance.

### Preventive action

- Keep the verifier fail-closed.
- Make refusal artifacts and failure classes easier to read as human-actionable results.
- Consider a bounded human-review path for repeated `verifier-mismatch` results rather than repeatedly paying the same repair loop.
- Do not allow repair to rewrite the Definition of Done silently. The current repair is intentionally limited to command/observed cells at `src/batch/prepare.ts:415-474`; expanding it would need a separate, explicit contract because changing the claim itself changes the basis of acceptance.

## Finding 3 — one global kind flag permits an operator mismatch

### Verified claim

The CLI accepts one optional `--kind` and passes it to every ticket in the request. It cannot express different kinds for different tickets in one batch.

### Evidence

- `src/batch/cli.ts:125-152` parses one `--kind` value and passes it once to `prepare`.
- `src/batch/request.ts:10-14` has one optional batch-level `kind`, not a per-ticket mapping.
- `src/batch/prepare.ts:669-676` uses the pinned kind for the ticket and suppresses triage classification when pinned.
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

- `src/batch/prepare.ts:612-647` bounds each model call and distinguishes provider/timeout errors from ticket verdicts.
- `src/batch/prepare.ts:649-697` runs triage, parses it, then runs the independent verifier.
- `src/batch/prepare.ts:700-735` rejects mismatches and only proceeds after the verifier accepts.
- `src/batch/prepare.ts:736-780` builds and preflights the manifest only after acceptance.
- `docs/batch-guide.md:93-126` documents the order: verify, build/preflight, then write the record/comment and add `ready-for-agent`.
- ADR 0004 states why this must happen outside the runtime: `docs/adr/0004-batch-driver-outside-the-runtime.md:5-13`. The runtime has no tracker tool and cannot fetch its own ticket.

### Consequence

The gate correctly prevented #49 and #45 from receiving manifests. #49 failed because the model/provider path did not complete; #45 failed because its evidence did not survive independent checking. These are different failure classes and should not be reported as one generic "ticket rejected" result.

### Preventive action

Keep the gate, but improve recoverability:
- persist stage-level evidence and a resumable prepare state so a provider timeout does not require repeating already-valid triage;
- distinguish `provider-error`, `timeout`, `unverifiable`, and `verifier-mismatch` in operator output and retry guidance;
- add a bounded retry policy by stage/model, rather than treating a connection error and a semantic mismatch as the same retry shape;
- add an explicit human-review outcome after repeated semantic mismatches.

The current retry mechanism is bounded and in-process: `src/batch/prepare.ts:357-411` retries a paid call, and `src/batch/prepare.ts:415-511` performs one claim-row repair round. It does not resume a completed stage in a later command.

## Recommended order of work

1. **Prevent operator kind errors.** Add per-ticket kind selection or reject mixed-ticket use of `--kind`. This is deterministic and cheap.
2. **Add claim-table structural linting.** Reject empty/invalid cells and cheap command faults before the verifier spends money.
3. **Add resumable prepare state.** Preserve accepted triage output and stage costs across provider failures; do not reuse it after the ticket or source revision changes.
4. **Improve refusal classification and human recovery.** Keep semantic mismatches fail-closed, but tell the operator whether the next action is retry, ticket repair, or human review.
5. **Add end-to-end tests for the publication boundary.** An accepted ticket must have manifest, matching comment criteria, and `ready-for-agent` in order; a refused ticket must have no manifest and no ready label.

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

## Status

- This document records findings and recommendations only.
- No production changes are made by this document.
- No recommendation above should be treated as implemented until its code, tests, and documentation are landed and independently verified.
