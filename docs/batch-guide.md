# Batch: tickets in, runs out

`mypi-batch` turns a list of GitHub tickets into verified manifests, then executes them one at a
time. It is a driver beside the runtime, not part of it: see
[ADR 0004](adr/0004-batch-driver-outside-the-runtime.md) for why.

```
mypi-batch new <id> <ticket...>        # write <taskDirs[0]>/000-batches/<id>/request.yaml
mypi-batch prepare <id> [--dry-run]    # verify each ticket, comment, label, generate manifest
mypi-batch run <id>                    # execute accepted manifests serially, halting on failure
mypi-batch launch <id> <ticket>        # write a halted ticket's manifest into its task dir
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

`prepare` reads the triage and verifier prompts from the driver's own `docs/explorations/triage-automation/`,
so the target repo does not need to vendor them. `prepare.kind_templates` paths resolve against the driver
too, so the shipped relative path (`templates/batch-code-fix.yaml`) works from any target repo; an absolute
path is still honoured.

**`<taskDirs[0]>/<batchDir>/<id>/request.yaml`** (default `mypi-tasks/000-batches/<id>/request.yaml`) is one batch, written once by `new` and never rewritten:

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
   `unverifiable`; an agent call that throws is `agent-error` — retryable infrastructure, not a
   verdict on the ticket.
3. `KIND:` must name a policy kind or `inline` (`kind-invalid`). `inline` publishes the DoD as a
   comment and stops: no manifest, no label.
4. Run the verifier on the claim table and parse its block. Any mismatch, or a row it could not
   run, is `verifier-mismatch`; a block whose rows do not line up with the report is
   `unverifiable`. The verifier then checks the DoD the same way: one verdict per criterion, a
   missing block or a count/order mismatch is `unverifiable`, a criterion it flags as unsound or
   as naming nothing real is `verifier-mismatch`. A `verifier-mismatch` refusal names
   `verdicts.json`, which holds the verifier's per-row evidence.
5. Normalize the DoD to plain text and refuse residuals (`dod-rejected`). The finalize gate folds
   only a label prefix, backticks, quotes, dashes and whitespace, so a checkbox or a markdown link
   costs a whole run.
6. Build the manifest from the kind's template (`template-missing`, `manifest-invalid`) and resolve
   every slug (`model-unavailable`).
7. Only now: write the record (`manifest.yaml` under `tickets/<n>/`), post the marker comment,
   then add `ready-for-agent`. `prepare` does **not** create the checkout task dir — `run` does.

`--dry-run` runs steps 1–6 and writes nothing. It is **not free**: both agents still run. A dry run
that skipped them would print a table nobody verified.

A refusal still posts the marker comment (with the reason code) and never touches the label.

## `run`

Serial, in request order, halting on the first non-success.
1. Refuse before spending: any manifest that fails `parseSessionConfig`, any slug that does not
   resolve, or a batch that already has run records — with no worktree and no workspace created.
2. Per ticket: create `../ma-wt-<slug>` on branch `task/<slug>` from `main`, install the manifest,
   and write the same manifest into the checkout task dir `<taskDirs[0]>/b-<batch>-t<n>/session.yaml`
   — the task dir exists only once a run starts. Then `herdr workspace create --label mypi-<slug>`,
   `herdr pane run <pane> 'pi "/mypi-multi-agent <slug>"'`.
3. Poll until `run-details/final.md` parses with `status`/`exit_code`, is unchanged across two
   reads, and the `.peer-*.json` files are gone. A vanished workspace is `startup-failed`, and so
   is a run that has not created `run-details/` within 60 s (twelve poll intervals) — `pi` exited
   before the runtime started, which is not a slow run; the batch timeout is `timeout`.
4. Close the workspace in `finally`. A success then commits the worktree's changes onto
   `task/<slug>` — the branch is the deliverable, so uncommitted edits would be discarded with the
   worktree — and a commit that throws turns the outcome into `failure`. Then copy the whole
   `run-details/` into `<taskDirs[0]>/b-<batch>-t<n>/run-details/` and write `run.json` into the
   record.
5. Anything after a non-success is recorded `batch-halted`.

After each ticket that actually ran, `run` writes one marker comment naming the outcome, exit code,
duration, branch and record path. On success it also removes `ready-for-agent` and adds
`ready-for-human` — the branch is unmerged, so a human picks it up. On any other outcome it keeps
`ready-for-agent`, so a retry batch still sees the ticket. `batch-halted` and pre-run refusals get no
comment, and no path closes the ticket.

Nothing is merged or pushed. The branch is the deliverable. There is no resume: a halted batch is
finished, and a retry is a new batch.

A successful ticket's worktree is removed once its work is committed and its `run-details/` are copied
to the checkout task dir (`<taskDirs[0]>/b-<batch>-t<n>/run-details/`); the branch stays. A ticket that did not succeed keeps its
worktree, because that is the one someone has to look at.

A ticket a halted batch never reached has a manifest in the record but no checkout task dir. To run it
on its own, `mypi-batch launch <id> <ticket>` materialises that manifest into
`<taskDirs[0]>/b-<batch>-t<n>/session.yaml` and refuses if the task dir already holds a
`run-details/final.md`.

## Records

```
mypi-tasks/000-batches/<id>/      # <taskDirs[0]>/<batchDir>/<id>/, batchDir in mypi-multi-agent.yaml
  request.yaml                    authored once
  summary.md                      the batch verdict, total cost, and one row per ticket (cost column)
  summary.json                    the same outcomes plus `totalCostUsd`, machine-readable
  tickets/<n>/report.md           the triage reply, verbatim — gitignored (raw agent output)
  tickets/<n>/verdicts.json       the verifier block — gitignored (raw agent output)
  tickets/<n>/manifest.yaml       the launchable manifest
  tickets/<n>/run.json            outcome, exit code, duration
  tickets/<n>/acceptance.json     accepted: kind, slug, criteria, cost
  tickets/<n>/refusal.json        a refusal and its reason code
```

Everything above except `report.md` and `verdicts.json` is committed: those two are raw model output —
the same class as a transcript — and stay local, matching the repo's rule that authored decisions are
committed and run artifacts are not.

The run's evidence lives beside the manifest, not in the record: a successful or failed run copies its
whole `run-details/` into `<taskDirs[0]>/b-<batch>-t<n>/run-details/` (`final.md`, `plan.md`,
`conversation.jsonl`, `scorecard.json`, and the rest). The record keeps only what was decided —
`run.json` and the prepare-time files above.

A batch task's scorecard reaches the quality ledger like any other run: after the batch, add its
checkout dir (`mypi-tasks/b-<batch>-t<n>`) to `quality/opt-in.json` and run `bun run collect`, which
reads the copied `run-details/scorecard.json`.

`summary.md` and `summary.json` carry each run's cost from its `final.md` frontmatter; a ticket that
never ran (`batch-halted`, `manifest-invalid`, `model-unavailable`, `startup-failed`) shows no cost —
empty in the table, absent in the JSON — never `0`. `totalCostUsd` sums only the runs that happened.

`report.md` and `verdicts.json` are written for a refused ticket as well: that is when someone
needs to know what the agents actually said. `acceptance.json` and `refusal.json` are mutually
exclusive — a re-prepare clears the other, so the record cannot claim two outcomes at once.

A batch task's manifest is materialised at `<taskDirs[0]>/b-<batch>-t<n>/session.yaml` — `mypi-tasks`
unless `mypi-multi-agent.yaml` configures another first task dir — flat so the runtime's
`resolveSessionPath` finds it (`run` writes it when the ticket starts, `launch` for a halted ticket).
That `session.yaml` is committed like any task's config; only its `run-details/` stays local. Both the
record and the task dir sit under `taskDirs[0]`, so the launch dirty-tree guard exempts them through the
task-dir exemption alone (`batchDir` is validated as a single segment, so it cannot escape that tree).

## Reason codes

`not-needed | unverifiable | agent-error | verifier-mismatch | dod-rejected | kind-invalid |
template-missing | already-prepared | manifest-invalid | model-unavailable | startup-failed |
timeout | failure | success | batch-halted`

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
- **`retemplate` is not implemented.** The kind is decided once, at `prepare`; changing it means a
  new batch.
