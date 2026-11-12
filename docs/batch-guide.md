# Batch: tickets in, runs out

`mypi-batch` turns a list of GitHub tickets into verified manifests, then executes them one at a
time. It is a driver beside the runtime, not part of it: see
[ADR 0004](adr/0004-batch-driver-outside-the-runtime.md) for why.

```
mypi-batch new <id> <ticket...>        # write <taskDirs[0]>/000-batches/<id>/request.yaml
mypi-batch prepare <id> [--dry-run] [--kind <kind>] [--break-lock]
                                       # verify each ticket, comment, label, generate manifest
mypi-batch run <id> [--quiet]          # execute accepted manifests serially, halting on failure
mypi-batch launch <id> <ticket>        # write a halted ticket's manifest into its task dir
mypi-batch status <id> [--wait]        # each ticket's outcome from the records; --wait blocks
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
| `labels`                        | what the four labels are called here, and whether a refusal may move one (see below)         |

**What bounds a prepare.** `prepare.agent_timeout_minutes` is the only number. Triage and the
verifier each get the whole of it; the repair round and the re-verification get a third each,
because they correct two cells of flagged rows rather than investigate the ticket. Every paid call
of one ticket is bounded by twice it in total, so the site permits sum above the deadline on
purpose: the deadline is the real bound and the permits only decide which site gets cut. The clock
starts after the clone: copying a checkout is local I/O, not a silent call. A site the deadline has
already spent is refused without a call, so nothing is retried there.

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
kind: code-fix # optional: one kind for every ticket, or a mapping of ticket to kind
```

`kind` may be a scalar or a mapping, and is optional either way; a ticket it does not name is
classified by triage. A mapping names only tickets in the request:

```yaml
kind:
  163: code-small
  164: code-fix
```

## `check`

`mypi-batch check <id>` runs only the gates that need neither a clone nor a model call: the issue is
open, it does not carry the skip label, this batch has no acceptance or run record for it, the pinned
kind is offered, every kind is described in the prompt document, and the body's own Definition of Done
folds to plain text with no unapplied agent-brief change. It writes nothing, posts nothing and changes
no label, so it is safe to run against a ticket you have not decided to batch. One line per ticket,
the reason code, and `what to change` under a refusal; exit 1 when any ticket would be refused.

The rest of the codes need the clone and the two paid calls: `verifier-mismatch`, `harness-error`, the
repair path, `template-missing`, `manifest-invalid` and `model-unavailable` depend on what the triage
answers with. `check` saying `ok` means no cheap gate refuses the ticket, not that a prepare will
accept it.

## `prepare`

Per ticket, in this order. The order is the guarantee: a ticket is never labelled before its
manifest validates.
1. A ticket that is not open is `not-needed`. A ticket labelled `not-batched` is `skipped`. A ticket that already has an acceptance or a run record is
   `already-prepared` — either file ends prepare for that ticket, so a second prepare spends
   nothing and cannot overwrite the record (#424). A brief that proposes a criterion change the
   body has not taken is `dod-unapplied`, refused here too, before the clone.
2. `--kind <kind>` pins the template, so a caller chooses the kind instead of the triage: the
   claims are still the triage's, and so is the DoD when the body states none. The pin is refused
   beside a request that maps kinds — one of the two has to decide — before the clone. A pinned
   kind the policy does not offer is
   `kind-invalid`, and a kind the policy offers that the prompt document cannot describe is
   `infra-error` (#386); both are refused here, before the
   clone. Then clone the checkout, run the triage prompt, parse the reply.
   When the issue body states a Definition of Done (or the `Acceptance criteria` section
   `/skill:to-tickets` writes), it owns the criteria: triage verifies that list and returns it
   unchanged, and the reply's copy is replaced by the body's before the verifier runs, so the
   gate, the record and the manifest all carry the body's list (#469).
   A reply that does not parse is `unverifiable`; an agent call that throws is `infra-error` —
   retryable infrastructure, not a verdict on the ticket. A claim row whose command would destroy or
   rewrite files, send data out, pipe a download into a shell, or name a path outside the clone is
   refused `unverifiable` naming the row, before the verifier is asked to run it (#483). The check is
   a deny-list over the command text: it removes the accidental class and does not stop deliberate
   code execution (`bun -e`, `sh -c`), which needs a sandbox around the agent call. A `VAR=value`
   assignment naming an absolute path is not a file argument and is not refused. So is a claim row in that class without
   spending a verifier call: an empty claim, command, observed or verdict cell records nothing, and
   a verdict's first word must be `true`, `partial` or `false`, and bold around that word is
   presentation — `**false** — why` reads as `false`, and the reason after the word stays the note
   (#464, #522). Only `**` and `__` fold: italic is not read as the word. A claim row is a block —
   `row <n>:`, `command:`, `observed:`, `verdict:` — not a table cell, because a table needs its pipes
   escaped and that escape is the same two characters as a command's own (#529). A reply whose claim rows number nothing is
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
   `retries.json` keeps each replaced attempt in the attempt's directory (a throw's entry has an empty
   `text` and names the fault).
3. `KIND:` must name a policy kind (`kind-invalid`). Every kind runs the verifier, builds a
   manifest, and is run.
4. Run the verifier on the claim rows and parse its block. Shape is read first: a block whose
   entries do not line up one-for-one with the report's rows and criteria is `unverifiable`, and so
   is a row named `could-not-run` while its verdict is not a mismatch, because the prompt makes an
   undecidable row a mismatch and the reply then contradicts itself. Shape is the only class the
   retry re-asks, and it comes first because a reply that cannot be read for one row cannot be read
   for anything else — and because a short DoD block is not curable by the repair round, so a
   two-fault ticket is refused at the same cost, sooner (#376). Then a row the verifier could not
   run is `harness-error` — the harness's fault, not a verdict on the ticket — and a mismatch is
   `verifier-mismatch`. A `match` whose row's command cannot run as written — an unset variable —
   is `harness-error` too, before any mismatch is weighed (#463); a cell that kept its markdown
   delimiters is refused one step earlier, as `unverifiable`, because the shell would run the span
   as a substitution and no run of that row is worth paying for (#520). The verifier then
   checks the DoD the same way: one verdict per criterion, a missing block or a count/order
   mismatch is `unverifiable` with a detail saying the reply is malformed, a criterion it flags
   as unsound or as naming nothing real is `verifier-mismatch`. A criterion may cite the claim rows
   it rests on as `rows 3, 7`; a citation to a row the table does not have, or one the block did not
   mark `match`, is `unverifiable` naming the row. That check runs last, so a cited mismatch is the
   row's own `verifier-mismatch` and stays repairable, and a DoD the issue body owns is not read for
   citations at all (#464). A `verifier-mismatch` or
   `harness-error` refusal names `verdicts.json`, which holds the verifier's per-row evidence.
   A claim-row `verifier-mismatch` gets one bounded repair round before it refuses: the author
   corrects the flagged rows' command/observed cells, the verifier re-runs those rows alone, and
   the merged block is re-checked. A refusal after that round names `merged.json`, the file whose
   rows it lists, so the detail and the evidence are the same block (#461). A repaired command that still cannot run — retained delimiters,
   an unset variable — is `unverifiable` before the re-verify is paid for. A repair that touches the DoD or KIND is `unverifiable`; a
   DoD-criterion mismatch never repairs. The re-verification names the flagged rows by either
   the re-table's own `1..n` or their original numbers, and a `could-not-run` row it names is
   checked against the block it is in: one that also carries a verdict, or that falls outside
   the rows re-verified, is `unverifiable` rather than silently dropped (#372).
5. Normalize the DoD to plain text and refuse residuals (`dod-rejected`). The finalize gate folds
   only a label prefix, backticks, quotes, dashes and whitespace, so a checkbox or a markdown link
   costs a whole run.
6. Build the manifest from the kind's template (`template-missing`, `manifest-invalid`) and resolve
   every slug (`model-unavailable`).
7. Only now: write the record (`manifest.yaml` under `tickets/<n>/`, plus this attempt's
   directory under `tickets/<n>/attempts/`), post the marker comment, then add `ready-for-agent`. `prepare` does **not** create the checkout task dir — `run` does.

`--dry-run` runs steps 1–6 and writes nothing. It is **not free**: both agents still run. A dry run
that skipped them would print a table nobody verified.

A refusal posts the marker comment with the reason code, one line of detail, and `What to change:` —
the sentence for that code from `REFUSAL_REMEDY` (`src/batch/prepare.ts`), so a refusal says what to
edit rather than only what failed. Whether it also moves a label is the
repository's call, because the labels are this project's words and another tracker's may mean
something else:

```yaml
labels: # every key is optional; these are the defaults
  ready: ready-for-agent
  needs_info: needs-info
  skipped: not-batched
  human: ready-for-human
  on_refusal: false # true moves `ready` to `needs_info` when the ticket itself is the cause
```

With `on_refusal: true`, a refusal caused by the ticket's own text — `unverifiable`,
`verifier-mismatch`, `dod-rejected`, `dod-unapplied` — removes `ready` and adds `needs_info`, so a
refused ticket stops advertising itself as grabbable. Every other code leaves the labels alone:
`infra-error` and `harness-error` are re-run, the policy codes are config, and `not-needed`/`skipped`
are a closed or opted-out ticket. A ticket that no request names is never touched at all.

**Every prepare agent runs in a sandbox on macOS.** The triage, verifier, repair and re-verify calls
are ordinary `pi` processes with a bash tool, and their commands come from model output over untrusted
ticket text, so each is spawned under `sandbox-exec` with a profile that denies every write except the
clone, the temp roots, the agent's own config directory and `/dev/null`. It also denies reads of
`~/.ssh`, `~/.aws`, `~/.gnupg` and `~/.netrc` (#487). `pi` is given a throwaway config directory
holding only `auth.json`, so the operator's own settings and extensions are never readable or
writable by the agent. Where `sandbox-exec` does not exist the spawn is unchanged.

**One prepare per ticket at a time.** Before the record check, `prepare` claims
`<id>/locks/<ticket>.lock` with `{ flag: "wx" }`, holding `{pid, startedAt}` (#427). A second prepare
on the same ticket refuses `already-prepared`, names the holder, spends nothing and creates no attempt
directory; the lock is released on success, refusal, throw and teardown. A lock whose pid is gone is
taken over without being asked — nobody is left to write the record it guarded. A lock whose pid is
alive, or whose contents cannot be read, is never stolen: age alone does not steal it, and
`--break-lock` is the operator's explicit escape. Pid liveness is a single-host fact, so a record
directory shared across machines needs the flag rather than the check.

## `run`

Serial, in dependency order: a failed ticket blocks its dependents, unrelated tickets still run.
1. Refuse before spending: any manifest that fails `parseSessionConfig`, any slug that does not
   resolve, or a batch that already has run records — with no worktree and no workspace created.
2. Per ticket: create `../ma-wt-<slug>` on branch `task/<slug>` from `main`, install the manifest,
   and write the same manifest into the checkout task dir `<taskDirs[0]>/b-<batch>-t<n>/session.yaml`
   — the task dir exists only once a run starts. Then `herdr workspace create --label mypi-<slug>`,
   `herdr pane run <pane> 'MYPY_UNATTENDED=1 pi "/mypi-multi-agent <slug>"'`. The prefix is not
   decoration: a peer has no confirmation UI, so without it the first write of the run waits for a
   keypress nobody can send (#415).
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
comment, and no path closes the ticket. A ticket refused during prepare is recorded as
`prepare-refused` when `run` reads its `refusal.json`; this is distinct from `manifest-invalid`
(a malformed or missing manifest without a refusal record) and does not halt unrelated tickets.
A dependent ticket receives `dependency-failed` and is not launched.

Nothing is merged or pushed. The branch is the deliverable. There is no resume: a batch runs once to
completion, and a retry is a new batch.

**What `prepare` prints.** Every step, with the time it took, as it happens:

```
541: start
clone 1.4s
triage:
  turn 1 at 2s
  bash 8ms · rg -n "criteriaMismatches" src/
  read 1ms · src/batch/prepare.ts
  turn 2 at 6s
triage attempt 1: 226.9s, turns 25, $0.0550
verifier:
  turn 1 at 4s
  bash 120ms · grep -rL '"use client"' src/app --include=page.tsx
verifier attempt 1: 24.4s, turns 2, $0.0019
preflight 312ms
541: evidence written in 9ms
541: unverifiable after 253.7s
```

Each site heads its own block, and inside it every completed turn and every finished tool call is one
line: the tool's own duration, then what it ran — the command, pattern or path, clipped to 100
characters. Tool timings come from pi's `tool_execution_end`, so the model's thinking time is what
remains between them. That is what tells a slow ticket from a stuck one. Attempt lines carry the site's total
duration, turns and cost (#512); a repair round adds `repair` and `re-verify` lines. Tickets are
prepared one after another, so every line stays grouped under the outcome it precedes. A prepare
driven through `channel: api` prints nothing, because it has no caller to print to.

**What it prints.** The run narrates itself on stdout, one line per observed event, so an unattended
run can be followed from the terminal that started it: a start block — batch, ticket, kind, slug,
worktree, branch, base, the supervisor's pane with the `herdr pane read <pane>` command that shows
it, and the deadline — then `AGENT_REGISTER`, `WORK_ORDER`, `INTENT_TO_MODIFY`, `FINAL_REPORT` and the
runtime's `ERROR`, `RETRY` and `FINALIZED` as they appear. A pane waiting for an answer is named,
with the key to press. A supervisor that stops making progress ends the ticket as
`supervisor-stalled`, saying which question it is stuck on or how long it has been quiet, instead of
running to the deadline. `--quiet` prints only the per-ticket outcome lines, for a script.

A successful ticket's worktree is removed once its work is committed and its `run-details/` are copied
to the checkout task dir (`<taskDirs[0]>/b-<batch>-t<n>/run-details/`); the branch stays. A ticket that did not succeed keeps its
worktree, because that is the one someone has to look at.

A ticket the batch never ran has a manifest in the record but no checkout task dir. To run it
on its own, `mypi-batch launch <id> <ticket>` materialises that manifest into
`<taskDirs[0]>/b-<batch>-t<n>/session.yaml` and refuses if the task dir already holds a
`run-details/final.md`.

## `status`

`mypi-batch status <id>` prints one line per ticket — `<ticket>\t<code>\t<detail>` from
`tickets/<n>/run.json`, or `pending` — and reads nothing from the run's log. With `--wait` it blocks
until `<batchDir>/<id>/summary.json` exists (`runBatch` writes it on every path), printing a line per
state change, so a run started in another terminal can be watched with one call instead of a `sleep`
loop (#453). A halted ticket writes no record of its own and is filled in from the summary.

## Records

```
mypi-tasks/000-batches/<id>/      # <taskDirs[0]>/<batchDir>/<id>/, batchDir in mypi-multi-agent.yaml
  request.yaml                    authored once
  summary.md                      the batch verdict, total cost, and one row per ticket (cost column)
  summary.json                    the same outcomes plus `totalCostUsd`, machine-readable
  tickets/<n>/manifest.yaml       the launchable manifest
  tickets/<n>/run.json            outcome, exit code, duration, attempts, `sandboxed`
  tickets/<n>/acceptance.json     accepted: kind, slug, criteria, cost
  tickets/<n>/refusal.json        a refusal and its reason code
  locks/<ticket>.lock             a prepare in flight — gitignored
  tickets/<n>/attempts/<k>/identity.json    issue-body hash and the clone's base revision
  tickets/<n>/attempts/<k>/decision.json    a copy of the record this attempt wrote
  tickets/<n>/attempts/<k>/report.md        the triage reply, verbatim — gitignored
  tickets/<n>/attempts/<k>/verdicts.json    the verifier block — gitignored
  tickets/<n>/attempts/<k>/repair.md        the repair round's reply — gitignored
  tickets/<n>/attempts/<k>/reverdicts.json  the re-verifier block — gitignored
  tickets/<n>/attempts/<k>/merged.json      the block that decided a repaired ticket — gitignored
  tickets/<n>/attempts/<k>/retries.json     each replaced attempt — gitignored

Every `prepare` writes one new `attempts/<k>/` directory, numbered from 1 once the cheap guards
pass, so a second prepare on a refused ticket never overwrites the first. That is what makes a
variance question answerable: whether triage or the verifier changed its answer needs both
attempts side by side. An attempt refused before the clone (a `--kind` the policy does not offer, a
brief delta the body has not taken) stores nothing, because nothing was paid for.

The deciding `acceptance.json`/`refusal.json` stays at the ticket root: `run` and `status` read it
there. The attempt keeps an identical `decision.json`, so the history of a ticket whose root record
a later attempt rewrote is still on disk. `identity.json` ties the attempt to the issue text and the
tree it checked — the pair that decides whether an earlier attempt's triage reply is reused (#466).
There is no separate stage log: these files are it. `report.md` means triage replied (a reused reply
included), `verdicts.json` means the verifier returned a block — a `{raw: …}` body meaning its reply
was refused — `merged.json` means the repair round finished, and `decision.json` says what was
decided. What a prepare paid for is the decision record's `durations` and `costUsd`, and `calls`
says what each paid attempt bought: one entry per site and attempt with the turn count, the
provider-reported token counts, the cost and the duration (#512). A site that made no call has no
entry — a reused triage reply or a call refused for lack of budget — and a token count the provider
did not report is absent rather than `0`. The same
record states where the triage reply came from: `triage: {ran: true}` when the attempt called triage,
`triage: {reusedFrom: k}` when it read attempt `k`'s reply (#484). An attempt with a `report.md` and
no `durations.triage` is the older, inferred reading; the field is the statement.

The record files above are the complete set written by `prepare`: the six evidence files are raw
model output, while the manifest, the decisions, `identity.json` and `decision.json` are
decisions.
`run` adds `run.json` to the ticket root after execution.
```

Everything else above is committed: the six files marked as raw agent output are the same class as a
transcript and stay local — the repo's rule commits authored decisions, not run artifacts. Listing which
ones stay local, rather than counting them, is what kept this sentence wrong once already. The flat
`tickets/<n>/report.md` and `tickets/<n>/verdicts.json` paths stay ignored as well, for records written
before the attempt directories (#460).

The run's evidence lives beside the manifest, not in the record: a successful or failed run copies its
whole `run-details/` into `<taskDirs[0]>/b-<batch>-t<n>/run-details/` (`final.md`, `plan.md`,
`conversation.jsonl`, `scorecard.json`, and the rest). The record keeps only what was decided —
`run.json` and the prepare-time files above.

A batch task's scorecard reaches the quality ledger like any other run: after the batch, add its
checkout dir (`mypi-tasks/b-<batch>-t<n>`) to `quality/opt-in.json` and run `bun run collect`, which
reads the copied `run-details/scorecard.json`.

`summary.md` and `summary.json` carry each run's cost from its `final.md` frontmatter; a ticket that
never ran (`batch-halted`, `manifest-invalid`, `prepare-refused`, `model-unavailable`, `startup-failed`, `dependency-failed`) shows no cost —
empty in the table, absent in the JSON — never `0`. `totalCostUsd` sums only the runs that happened.

An attempt's `report.md` and `verdicts.json` are written for a refused ticket as well: that is when
someone needs to know what the agents actually said. `acceptance.json` and `refusal.json` are mutually
exclusive within one attempt — the writing path clears the other, so one prepare cannot claim two
outcomes at once (#247). Across attempts an acceptance wins: a later refusal leaves
`acceptance.json` byte-identical, writes no `refusal.json` and posts no marker, so a mistyped flag
cannot destroy a record a previous prepare accepted (#424). A conditional later `--kind` check is
no exception: the guard, not the check order, is what keeps the file.

A batch task's manifest is materialised at `<taskDirs[0]>/b-<batch>-t<n>/session.yaml` — `mypi-tasks`
unless `mypi-multi-agent.yaml` configures another first task dir — flat so the runtime's
`resolveSessionPath` finds it (`run` writes it when the ticket starts, `launch` for a halted ticket).
That `session.yaml` is committed like any task's config; only its `run-details/` stays local. Both the
record and the task dir sit under `taskDirs[0]`, so the launch dirty-tree guard exempts them through the
task-dir exemption alone (`batchDir` is validated as a single segment, so it cannot escape that tree).

## Reason codes

`not-needed | skipped | unverifiable | infra-error | harness-error | verifier-mismatch | dod-rejected | dod-unapplied | kind-invalid |
template-missing | already-prepared | manifest-invalid | prepare-refused | model-unavailable | startup-failed | supervisor-stalled |
timeout | failure | dependency-failed | success | batch-halted`

These are the codes the code can emit. The design also named `outdated` and `blocked-decision`;
triage collapses both into `not-needed`, so neither is reachable.

## Known limits

- **A satisfied ticket fails as `failure`.** Step 4 refuses a branch with no commits, so a run whose
  implementers wrote nothing fails with the worktree kept for inspection; unrelated tickets still run.
- **The run is sandboxed per process, and inherits the same limits.** The supervisor and every peer
  pane get their own sandbox plus their own `PI_CODING_AGENT_DIR`, because the herdr daemon creates
  panes and inherits nothing (#489). The profile opens the worktree, the repository's git dir, the
  temp roots and `/dev/null`: a worktree's `.git` is a _file_ pointing at `<repo>/.git/worktrees/<slug>`,
  so a commit writes into the main repository and fails without it (measured). A run's agent cannot
  write outside those, but the network, the gh token and `auth.json` limits are #487's, unchanged.
- **The sandbox can be switched off, which weakens a run.** `MYPY_NO_SANDBOX=1` makes the batch spawn
  its agents and panes unconfined, exactly as it does on a platform without `sandbox-exec`. It exists
  so the unsandboxed path can be tested where the sandbox is present; it can only turn the sandbox
  off, never fake it.
- **The clone carries no environment file, and the agent inherits no environment.** `cp -R` copies
  ignored files with the code, and a repository keeps its production credentials in a gitignored
  `.env.local`, so the copy step deletes every `.env*` file except `*.example` before an agent sees it
  (`src/batch/clone.ts`). The child also gets an allowlist of the variables a shell needs (`PATH`,
  `HOME`, `TMPDIR`, the locale) and nothing else, because the sandbox confines writes and an inherited
  credential can still be read and sent (`src/batch/agent.ts`). A claim that needs `DATABASE_URL`
  therefore fails as `harness-error` — the honest answer, since the alternative is a production read.
  A machine that authenticates `pi` by environment variable instead of `~/.pi/agent/auth.json` breaks
  under the allowlist: put the credential in `auth.json` first.
- **The sandbox does not confine the network, and does not exist off macOS.** The profile language
  rejects host and IP rules, and the agent needs the provider anyway, so a claim command can still
  send out what the clone holds. The gh token stays readable because `gh issue view` is how a claim
  checks the ticket, and the copied `auth.json` is readable for the same reason. On Linux the spawn
  is unchanged, so the deny-list in `commandFaults`-adjacent parsing (#483) is the only portable
  layer.
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
