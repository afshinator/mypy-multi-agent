# Batch reviewers review the change, not only the criteria (rung 3 preparation)

Follow-up to the #368 work and to rung 2 of the batch ladder. The `code-small` and
`batch-code-fix` reviewers attested every DoD criterion and nothing else: a change could pass
each criterion, follow none of the repository's review standard, and add abstraction nobody
asked for, because no duty in the prompt covered the diff itself.

## What changed

Both reviewers now carry a two-axis review in R2, before the attestation:
- **Standards** — the repository's own standard first (`AGENTS.md`'s review file,
  `docs/agents/review.md` where the repo has one, otherwise `CODING_STANDARDS.md`), then the
  twelve-smell baseline from the `code-review` skill. A documented standard wins over the
  baseline; a smell is a labelled judgement, never a hard violation; nothing tooling already
  enforces is repeated.
- **Spec** — does the diff do what the ticket asked, and no more. Unrequested abstraction, an
  option nobody asked for, a new dependency, or a change no criterion needed is a finding.

A finding on either axis blocks a pass. The report is capped at ten findings, most consequential
first, each as `<axis> <file:line> — what is wrong — the fix` (§10 R4: a peer asked for one row
per finding silently truncates).

The supervisor carries the matching step: run `git diff main...HEAD`, paste it into the
reviewer's work order with the stats, and split a long diff into packets. The reviewer has
`shell: false` by design — its verdict rests on what it reads — so the diff reaches it through
the supervisor and never as the supervisor's summary of it.

## Why the diff is pasted rather than run

The alternative was `shell: true` plus a `shell_allowlist`, which the schema permits for a
read-only peer. It does not work here: `canShell` (`src/pi/tool-permissions.ts:42`) is an exact
string match, so the reviewer would need every diff command spelled out verbatim, and any
variant — `main..HEAD`, a `--stat` call, a path filter — would be refused as a permission fault
rather than a review. Pasting the diff keeps one authority for what the change is, and keeps the
reviewer's tool surface unchanged.

## What it should fix, and how it will be measured

rung 3 runs `code-small` on strata #58 (`session-stats` script). The measurement is the
reviewer's own findings list in `run-details/final.md`: whether it names at least one real,
file:line-tied finding on either axis, and whether anything it flags is wrong. A reviewer that
reports "both axes clean" on a diff with unrequested abstraction has not been fixed by this, and
the prompt should say so more sharply.

Not yet measured: nothing here asserts the change works. It is a prompt change with a stated
rationale, following §10's rule to record the intent rather than claim a win.
