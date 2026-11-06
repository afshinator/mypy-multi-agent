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
| `prepare.agent_timeout_minutes` | the one knob every prepare bound derives from (a full call's permit, the deadline)           |
| `run.timeout_minutes`           | one run's bound; nothing inside the runtime provides one                                     |

**What bounds a prepare.** `prepare.agent_timeout_minutes` is the only number. Triage and the
verifier each get the whole of it; the repair round and the re-verification get a third each,
because they correct two cells of flagged rows rather than investigate the ticket. Every paid call
of one ticket is bounded by twice it in total, so the site permits sum above the deadline on
purpose: the deadline is the real bound and the permits only decide which site gets cut. A call is
always retried once per site. The clock starts after the clone: copying a checkout is local I/O,
not a silent call.

| worst case for one ticket's prepare | value at the shipped 15 |
| ----------------------------------- | ----------------------- |
| one call, triage or verifier        | 15 min                  |
| one call, repair or re-verify       | 5 min                   |
| all its paid calls, deadline        | 30 min                  |

A prepare whose triage and verifier both run near a full permit reaches the repair round with
nothing left and refuses there rather than overspending; that is the accepted trade for a bound.
Each paid call's wall time is recorded — `durationMs` on the retry record, once per site in
`acceptance.json` and `refusal.json` — so the knob is tuned from measurements, not guesswork (#403).

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
1. A ticket that is not open is `not-needed`. A ticket labelled `not-batched` is `skipped`. A ticket that already has a run record is
   `already-prepared`.
2. A kind the policy offers that the prompt document cannot describe is refused here, before the
   clone, as `infra-error` (#386). Then clone the checkout, run the triage prompt, parse the reply.
   A reply that does not parse is `unverifiable`; an agent call that throws is `infra-error` —
   retryable infrastructure, not a verdict on the ticket. A reply whose claim table has no rows is
   a parse failure, so the gate never sees an empty report (#392).

   Every paid call is attempted at most twice (#368): a throw is re-sent at all four sites
   (triage, verifier, repair, re-verify), and a reply that does not parse — or a verdict block
   that parses but does not line up — is re-asked at three of them. Triage prose is never
   re-pulled: a second sample would re-decide the ticket rather than re-check a format. A
   verdict is never retried. The record names the retried call site (`retried: [...]`, empty
   when nothing failed) and its cost sums both attempts — including when a fault after the retry
   refuses the ticket as `infra-error`, so a prepare never records a free run. A retry that also
   fails reports the code the _first_ failure would have: a throw is `infra-error`, a malformed
   reply `unverifiable`, and attempt order does not decide between them. A re-ask is not a
   resample: when the first reply was read and rejected, the second attempt's prompt names that
   fault (`RETRY … could not be read: 5 verdicts for 6 criteria`), because a systematic mistake
   reproduces under an identical prompt. A throw produced no reply to describe, so that retry is
   byte-identical. The retry is visible wherever a human looks: `retried: <sites>` trails the
   outcome line, the ticket comment names it on both the accepted and refused paths, and
   `retries.json` keeps each replaced attempt beside the record (a throw's entry has an empty
   `text` and names the fault).
3. `KIND:` must name a policy kind (`kind-invalid`). Every kind runs the verifier, builds a
   manifest, and is run.
4. Run the verifier on the claim table and parse its block. Shape is read first: a block whose
   entries do not line up one-for-one with the report's rows and criteria is `unverifiable`, and so
   is a row named `could-not-run` while its verdict is not a mismatch, because the prompt makes an
   undecidable row a mismatch and the reply then contradicts itself. Shape is the only class the
   retry re-asks, and it comes first because a reply that cannot be read for one row cannot be read
   for anything else — and because a short DoD block is not curable by the repair round, so a
   two-fault ticket is refused at the same cost, sooner (#376). Then a row the verifier could not
   run is `harness-error` — the harness's fault, not a verdict on the ticket — and a mismatch is
   `verifier-mismatch`. The verifier then
   checks the DoD the same way: one verdict per criterion, a missing block or a count/order
   mismatch is `unverifiable` with a detail saying the reply is malformed, a criterion it flags
   as unsound or as naming nothing real is `verifier-mismatch`. A `verifier-mismatch` or
   `harness-error` refusal names `verdicts.json`, which holds the verifier's per-row evidence.
   A claim-row `verifier-mismatch` gets one bounded repair round before it refuses: the author
   corrects the flagged rows' command/observed cells, the verifier re-runs those rows alone, and
   the merged block is re-checked. A repair that touches the DoD or KIND is `unverifiable`; a
   DoD-criterion mismatch never repairs. The re-verification names the flagged rows by either
   the re-table's own `1..n` or their original numbers, and a `could-not-run` row it names is
   checked against the block it is in: one that also carries a verdict, or that falls outside
   the rows re-verified, is `unverifiable` rather than silently dropped (#372).
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

Serial, in dependency order: a failed ticket blocks its dependents, unrelated tickets still run.
1. Refuse before spending: any manifest that fails `parseSessionConfig`, any slug that does not
   resolve, or a batch that already has run records — with no worktree and no workspace created.
2. Per ticket: create `../ma-wt-<slug>` on branch `task/<slug>` from `main`, install the manifest,
   and write the same manifest into the checkout task dir `<taskDirs[0]>/b-<batch>-t<n>/session.yaml`
   — the task dir exists only once a run starts. Then `herdr workspace create --label mypi-<slug>`,
   `herdr pane run <pane> 'pi "/mypi-multi-agent <slug>"'`.
3. Poll until `run-details/final.md` parses with `status`/`exit_code`, is unchanged across two
   reads, and the `.peer-*.json` files are gone. A vanished workspace is `startup-failed`, and so
   is a run that has not created `run-details/` within a tenth of its own timeout, capped at 60 s
   — `pi` exited before the runtime started, which is not a slow run; the batch timeout is
   `timeout`. Both start-failure shapes are relaunched once, in the same worktree, before the
   batch halts: a start fault is the one outcome most likely to be transient (D12). `run.json`
   records how many launches a ticket needed in `attempts`.
4. Close the workspace in `finally`. A success then commits the worktree's changes onto
   `task/<slug>` — the branch is the deliverable, so uncommitted edits would be discarded with the
   worktree — leaving out the manifest under the task dir, which is run metadata rather than work.
   A commit that throws, and a branch left with no commits beyond `main`, both turn the outcome
   into `failure`: `success` means the branch carries work. Then copy the whole `run-details/` into
   `<taskDirs[0]>/b-<batch>-t<n>/run-details/` and write `run.json` into the record.
5. A non-success marks the ticket failed; its transitive dependents are recorded
   `dependency-failed` and unrelated tickets still run.

Who runs what: the verifier already proved each criterion's command at `prepare` time (step 4); the
run's two implementers run the affected tests while they work; the finalize gate runs
`validation.commands` (`bun run check`) mechanically; and the attester never runs anything — it
reads `file:line` evidence from the branch. An exit code named in a DoD is the gate's job, not the
attester's.

After each ticket that actually ran, `run` writes one marker comment naming the outcome, exit code,
duration, branch and record path. On success it also removes `ready-for-agent` and adds
`ready-for-human` — the branch is unmerged, so a human picks it up. On any other outcome it keeps
`ready-for-agent`, so a retry batch still sees the ticket. `dependency-failed` and pre-run refusals get no
comment, and no path closes the ticket.

Nothing is merged or pushed. The branch is the deliverable. There is no resume: a batch runs once to
completion, and a retry is a new batch.

A successful ticket's worktree is removed once its work is committed and its `run-details/` are copied
to the checkout task dir (`<taskDirs[0]>/b-<batch>-t<n>/run-details/`); the branch stays. A ticket that did not succeed keeps its
worktree, because that is the one someone has to look at.

A ticket the batch never ran has a manifest in the record but no checkout task dir. To run it
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
  tickets/<n>/run.json            outcome, exit code, duration, attempts
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
never ran (`batch-halted`, `manifest-invalid`, `model-unavailable`, `startup-failed`, `dependency-failed`) shows no cost —
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

`not-needed | skipped | unverifiable | infra-error | harness-error | verifier-mismatch | dod-rejected | kind-invalid |
template-missing | already-prepared | manifest-invalid | model-unavailable | startup-failed |
timeout | failure | dependency-failed | success | batch-halted`

These are the codes the code can emit. The design also named `outdated` and `blocked-decision`;
triage collapses both into `not-needed`, so neither is reachable.

## Known limits

- **A satisfied ticket fails as `failure`.** Step 4 refuses a branch with no commits, so a run whose
  implementers wrote nothing fails with the worktree kept for inspection; unrelated tickets still run.
- **A refusal does not clear `ready-for-agent`.** The label carries no batch identity, so removing
  it could strip it from a ticket another batch prepared.
- **The verifier's sampling rule is not implemented.** Every claim row is checked, which is
  stricter and costs more on tables above ~10 rows.
- **A claim may read state that changes between triage and verify.** The claim command runs in the
  clone, but nothing stops it from naming an absolute path outside the clone, and nothing checks
  that its target is stable: the author writes the row from one reading and the verifier re-runs it
  later. A ticket whose claims rest on a growing log or a machine-local file refuses intermittently,
  and no check can tell that case from a claim on a fixed file — choosing the target is the fix.
- **`retemplate` is not implemented.** The kind is decided once, at `prepare`; changing it means a
  new batch.
