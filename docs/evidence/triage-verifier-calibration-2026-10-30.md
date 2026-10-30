# Evidence: the triage verifier pass, 2026-10-30

**Question.** Does a second agent, given only another agent's claim table, refuse the rows
that do not reproduce?

**Method.** Two tables with _known_ defects, each given to one verifier with no other context:
read-only tools, its own model (`commandcode/gpt-6-luna`, a different family from the author),
in a disposable clone. It was told to re-run each row's own command and to return one verdict
per row, with an undecidable row counting as a mismatch.

| table | rows | defect planted                                                                                                                          | expected          | returned | judge                                                             |
| ----- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------- | ----------------------------------------------------------------- |
| A     | 6    | row 1: field list cited at `:70` (it is at `:71`)                                                                                       | mismatch          | mismatch | correct                                                           |
| A     | 6    | row 6: `:207` cited as the table separator (it is a table row; the separator is `:208`)                                                 | mismatch          | mismatch | correct                                                           |
| A     | 6    | rows 2-5 sound                                                                                                                          | match             | match    | correct                                                           |
| A     | 6    | row 5's command was `rg -rn lock-frames docs/` — **not planted**                                                                        | (intended: match) | mismatch | **correct: the command was broken**                               |
| B     | 2    | row 2: "the payload is read again in full" — the notice is 200 chars and itself instructs the fetch, so the call is the first full read | mismatch          | mismatch | correct                                                           |
| B     | 2    | row 1 sound                                                                                                                             | match             | mismatch | **correct: the citation range started after the line it claimed** |

Cost: 6 turns, ~20k tokens, both tables. Zero false matches.

**What it establishes.** Every defect in both tables was refused, including the one planted in
the reasoning rather than in a line number (B2, where the verifier reported that the code shows
no re-read rather than comparing strings). Nothing wrong was passed as a match, which is the
only property that protects a run: a wrong `match` admits a false claim to the plan.

**What it also showed, unintentionally.** Two rows I believed were sound were not:
- `rg -rn lock-frames docs/` — `-r` means **replace**, so the row's own output had
  `lock-frames` replaced by `n` and could not support the claim. `AGENTS.md` documents this
  trap, and the verifier flagged it instead of papering over it.
- `sed -n '382,387p'` for a claim about a line at 378 — a range that excludes the evidence.

Both are correct mismatches and needless re-investigations. The rule "an undecidable row is a
mismatch" is what caught them, and it should stay.

**Limits.** One run of each table, one verifier model, two tables. This shows the pass _can_
refuse a defect; it does not measure a false-mismatch rate across well-formed tables, and the
single-family evidence problem is only partly addressed by using a different model family.
The counter row dropped from table B is why: a byte count is unverifiable once the artifact it
counted changes, so counters in a claim table must be stamped with the artifact and the time.

Related: `docs/triage-verifier.md` (the prompt and how to run it),
`docs/evidence/triage-prompt-2026-10-29.md` (why the pass exists: two of nine triage reports
needed correction, both written by the author of the triage prompt).
