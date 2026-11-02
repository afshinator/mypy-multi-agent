# Batch: tickets in, runs out

`mypi-batch` turns a list of GitHub tickets into verified manifests, then executes them one at a
time. It is a driver beside the runtime, not part of it: see
[ADR 0004](adr/0004-batch-driver-outside-the-runtime.md) for why.

```
mypi-batch new <id> <ticket...>        # write batches/<id>/request.yaml
mypi-batch prepare <id> [--dry-run]    # verify each ticket, comment, label, generate manifest
mypi-batch run <id>                    # execute accepted manifests serially, halting on failure
```

## The two files

**`mypi-batch.yaml`** (repo root, committed) is policy. It is read by `prepare` and `run` and never
written by either.

| key                             | meaning                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `prepare.kinds`                 | the kinds the triage agent may answer with, injected into its prompt                         |
| `prepare.kind_templates`        | kind → template path; every kind must have one and every entry must be a kind                |
| `prepare.triage_model`          | model for the investigation                                                                  |
| `prepare.verifier_model`        | model for the claim check — a different family from the author, or it shares its blind spots |
| `prepare.agent_timeout_minutes` | one agent call's bound                                                                       |
| `run.timeout_minutes`           | one run's bound; nothing inside the runtime provides one                                     |

**`batches/<id>/request.yaml`** is one batch, written once by `new` and never rewritten:

```yaml
id: b1
tickets: [163, 164]
kind: code-fix # optional; defaults to the first kind in policy
```

## `prepare`

Per ticket, in this order. The order is the guarantee: a ticket is never labelled before its
manifest validates.
1. A ticket that is not open is `not-needed`. A ticket that already has a run record is
   `already-prepared`.
2. Clone the checkout, run the triage prompt, parse the reply. A reply that does not parse is
   `unverifiable`.
3. `KIND:` must name a policy kind or `inline` (`kind-invalid`). `inline` publishes the DoD as a
   comment and stops: no manifest, no label.
4. Run the verifier on the claim table and parse its block. Any mismatch, or a row it could not
   run, is `verifier-mismatch`; a block whose rows do not line up with the report is
   `unverifiable`.
5. Normalize the DoD to plain text and refuse residuals (`dod-rejected`). The finalize gate folds
   only a label prefix, backticks, quotes, dashes and whitespace, so a checkbox or a markdown link
   costs a whole run.
6. Build the manifest from the kind's template (`template-missing`, `manifest-invalid`) and resolve
   every slug (`model-unavailable`).
7. Only now: write the record, write the manifest, post the marker comment, then add
   `ready-for-agent`.

`--dry-run` runs steps 1–6 and writes nothing. It is **not free**: both agents still run. A dry run
that skipped them would print a table nobody verified.

A refusal still posts the marker comment (with the reason code) and never touches the label.

## `run`

Serial, in request order, halting on the first non-success.
1. Refuse before spending: any manifest that fails `parseSessionConfig`, any slug that does not
   resolve, or a batch that already has run records — with no worktree and no workspace created.
2. Per ticket: create `../ma-wt-<slug>` on branch `task/<slug>` from `main`, install the manifest,
   `herdr workspace create --label mypi-<slug>`, `herdr pane run <pane> 'pi "/mypi-multi-agent <slug>"'`.
3. Poll until `run-details/final.md` parses with `status`/`exit_code`, is unchanged across two
   reads, and the `.peer-*.json` files are gone. A vanished workspace is `startup-failed`; the
   batch timeout is `timeout`.
4. Close the workspace in `finally`, copy `final.md`, `findings.md` and `scorecard.json` into the
   record, write `run.json`.
5. Anything after a non-success is recorded `batch-halted`.

Nothing is merged or pushed. The branch is the deliverable. There is no resume: a halted batch is
finished, and a retry is a new batch.

## Records

```
batches/<id>/
  request.yaml                    authored once
  summary.md                      the batch verdict and one row per ticket
  summary.json                    the same outcomes, machine-readable
  tickets/<n>/report.md           the triage reply, verbatim (refusals included)
  tickets/<n>/verdicts.json       the verifier block, or { raw } when it did not parse
  tickets/<n>/manifest.yaml       generated (gitignored)
  tickets/<n>/run.json            outcome, exit code, duration
  tickets/<n>/{final,findings}.md copied out of the run
  tickets/<n>/scorecard.json      copied out of the run
  tickets/<n>/refusal.json        a refusal and its reason code
```

`report.md` and `verdicts.json` are written for a refused ticket as well: that is when someone
needs to know what the agents actually said.

Generated manifests also live at `mypi-tasks/b-<batch>-t<n>/session.yaml`, flat so the runtime's
`resolveSessionPath` finds them. Both paths are ignored and both are exempt from the launch
dirty-tree guard through `recordDirs`.

## Reason codes

`not-needed | unverifiable | verifier-mismatch | dod-rejected | kind-invalid | template-missing |
already-prepared | manifest-invalid | model-unavailable | startup-failed | timeout | failure |
success | batch-halted`

These are the codes the code can emit. The design also named `outdated` and `blocked-decision`;
triage collapses both into `not-needed`, so neither is reachable.

## Known limits

- **`inline` is the common answer.** Triage is built to shrink a ticket to its smallest defensible
  change, and small changes do not warrant a run. In four live triages every ticket came back
  `inline`, so the `code-fix` writeback path is covered by tests but has never been exercised live.
- **No retry on `startup-failed`.** The design called for one; it is not implemented. A start
  failure halts the batch.
- **A refusal does not clear `ready-for-agent`.** The label carries no batch identity, so removing
  it could strip it from a ticket another batch prepared.
- **The verifier's sampling rule is not implemented.** Every claim row is checked, which is
  stricter and costs more on tables above ~10 rows.
- **Worktrees are not cleaned up.** Each attempt leaves `../ma-wt-<slug>` and its branch.
- **`retemplate` is not implemented.** The kind is decided once, at `prepare`; changing it means a
  new batch.
