# The triage verifier

A triage report is a claim like any other. Nine triage runs were judge-checked by hand and
two of them — reports written by the session that wrote the triage prompt — contained claims
that did not hold: two off-by-one citations in #139, an overstated mechanism in #125. The
author's own step 5 is a self-review, so it does not catch this.

This is the pass that does, before a DoD is accepted.

## The prompt

The operator pastes the report's **claim table** into `CLAIM TABLE` below. Nothing else is
given: not the report's prose, not its reasoning, not the issue's body.

````text
SITUATION
Another agent investigated a GitHub issue in this repository and produced the claim table
below. Each row says: this claim, this command, this observed result. You did not write it,
you have not seen its reasoning, and nobody has checked it. Your job is to decide, row by
row, whether re-running its command reproduces what the row says it observed.

FUNCTION AND ARTIFACT
The artifact you own is your reply: one verdict block, nothing else. You write no file,
change no code, and start nothing — read-only tools only (`read`, `bash`, `grep`, `find`,
`ls`). `bash` can still write, so the rule is explicit: no redirects, no `rm`/`mv`/`cp`, no
`git` command that changes state, and no edit to any file. If a command you ran changed
something, say so in your reply.

Re-run each row's own command and compare its output to the row's `observed` cell, as
written. Then:

- `match`: the output supports the row as written.
- `mismatch`: it does not. A wrong line number, a symbol that is not there, a count that
  differs, or a conclusion the output does not support are all mismatches. Wording that
  differs without changing the meaning is not.

Do not re-investigate the row beyond re-running it. Do not fix, rewrite, or improve the
table. Do not add rows. If a command cannot run, or its output cannot decide the row, that
row is `mismatch` and you name the reason — an undecidable row is not a pass.

The working directory is a disposable clone. Paths in the table are absolute or relative to
this repository's root: `/tmp/verify-cal`. Your own cwd is a worktree inside it, so use the
absolute path when a relative one does not resolve.

STAKES AND CONSUMER
A human accepts or rejects a Definition of Done from your block. A wrong `match` lets a false
claim into the plan a run then executes, which is the failure this pass exists to stop: an
implementer sent to a file at a line that does not exist, or onto a surface that cannot reach
the mechanism. A wrong `mismatch` costs a re-investigation. Be exact, do not be charitable,
and do not pad the block with anything the rows do not require.

WHEN A ROW DOES NOT REPRODUCE
Report it as `mismatch` with the output you saw. Do not correct the row, do not correct the
claim, and do not write the replacement text. Your block is the finding; the author or the
human decides what to do with it.

Output exactly this, and nothing else: a fenced ```json block containing one entry per row in
table order, then a single line beginning `could-not-run:` naming any command you could not
run (or `could-not-run: none`). No preamble, no summary, no commentary.

The block:
[
  { "row": 1, "verdict": "match" | "mismatch", "evidence": "<the output you saw, in one line>" },
  ...
]

CLAIM TABLE
<paste the report's claim table here, one row per line>
````

## How to run it

- **One fresh agent, a different model from the author's.** The nine-run evidence came from a
  single model family, so a verifier on the same family shares its blind spots.
  `commandcode/gpt-6-luna` is the cheap default here; the catalog lists its price.
- Run it in a disposable clone (`cp -Rc <repo> /tmp/verify-<issue>`), read-only tools
  (`read`, `bash`, `grep`, `find`, `ls`), and pass the table inline.
- **Absolute paths only.** A `bash` child runs in its own worktree under
  `$CLONE/.git/subagents/<run>/<task>`, and `git rev-parse --show-toplevel` resolves to that
  worktree, so a relative path does not mean the repository root.
- **Sample, fixed in advance, chosen by the operator and not the author:** every row a DoD
  proof cites, every row whose verdict is `partial` or `false` (its correction is a new
  claim), plus two `true` rows from the top of the table. Cap at six; if the rule yields more,
  take the first six in table order and say so. A table of six rows or fewer is sampled whole.
- **Failure policy:** one `mismatch`, or one `could-not-run` that is not `none`, means the DoD
  is **not accepted**. It goes back to the author, or to the human when the two disagree about
  the same command's output. A clean block is attached to the accepted report.
- **Where things live:** the report and the block are passed inline; the durable record is an
  issue comment. The accepted DoD replaces the body, which is what an implementer reads.
  Comments do not appear in `gh issue view`, so posting one does not spoil a later blind test.

## Calibration result, 2026-10-30

Both known-wrong tables were checked, one verifier each, read-only, 6 turns and ~20k tokens
total, on `commandcode/gpt-6-luna`:

| table | rows | planted defect                                                                                        | returned                | judge           |
| ----- | ---- | ----------------------------------------------------------------------------------------------------- | ----------------------- | --------------- |
| A     | 6    | field list at `:70` (it is `:71`); `:207` called the separator (it is a row; the separator is `:208`) | 3 mismatches, 3 matches | all six correct |
| B     | 2    | "the payload is read again in full" (the notice is 200 chars and instructs the fetch)                 | 2 mismatches            | both correct    |

It also refused two rows I believed were sound, and it was right both times: one command was
`rg -rn lock-frames docs/`, where `-r` means **replace**, so the row's own output could not
support it (`AGENTS.md` already documents that trap); and one citation range began _after_ the
line it claimed. Zero false matches — the property that matters, because a wrong `match` is
what admits a false claim to a run.

Two consequences for whoever writes the next claim table:
- **The command must contain what the row claims.** A range that excludes the symbol is a
  correct mismatch and a needless re-investigation.
- **Stamp counters.** A byte or call count is unverifiable once the artifact it counted
  changes, and the verifier will keep calling it a mismatch.

Full record: `docs/evidence/triage-verifier-calibration-2026-10-30.md`.
