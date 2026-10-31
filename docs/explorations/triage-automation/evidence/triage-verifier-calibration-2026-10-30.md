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

Related: `docs/explorations/triage-automation/triage-verifier.md` (the prompt and how to run it),
`docs/explorations/triage-automation/evidence/triage-prompt-2026-10-29.md` (why the pass exists: two of nine triage reports
needed correction, both written by the author of the triage prompt).

## First real cycle, same day: #135's correction header

The pass's first use on real work: the header written by hand into #135 after that issue was
implemented. Six rows, one verifier per run, ~12k tokens each, `commandcode/gpt-6-luna`.

**Run 1 (before the path rule).** Four rows came back `could-not-run`: the table used relative
paths, and its verifier runs in a worktree that does not contain the untracked `mypi-tasks/`.
The block was honest about it (`could-not-run: rows 1,2,3,6`), so the acceptance decision was
"not accepted" — correctly, because the table as delivered could not be decided. One row was a
real defect: the header cited `src/pi/extension.ts:264`, and the call is at **:265**, moved by
the very commit the header describes (`1fd5448` added a line above it).

**Run 2 (after the path rule, with the line corrected).** Four matches, two mismatches, and
**both mismatches were right**:
- The row claimed the briefing is "rendered only in the `--resume` branch, at `:265`". Its
  command showed one call site at 265 but nothing about the branch. The citation was correct;
  the claim outran the command. A row may carry only what its command shows.
- The row claimed three `INTENT_TO_MODIFY` entries with an unknown path, and published
  `rg -c 'filePath": "<unknown>"'` — which returns nothing. The raw log writes
  `"filePath":"<unknown>"`, **no space**, and the author had "verified" the pattern from a
  `python3 json.dumps` re-render, which inserts one. The underlying fact is true; the published
  command could not show it.

**What this establishes.** In its first real use the pass refused two defects out of six rows
and was right both times, on top of the eight defects it found during calibration. Still no
false match. It also produced two authoring rules, now in `docs/explorations/triage-automation/triage-verifier.md`: a row
carries only what its command shows, and the exact published command text must be run against
the raw artifact.
