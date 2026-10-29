# 0003 — The quality loop's corpus and taxonomy

## Decision

**D1. The corpus is defined by `quality/opt-in.json`.** One entry per run root, kept in
**run-date order**, because a record's `beforeCount` is a prefix of that order and must mean
"the runs that existed when the change landed". Smoke and guard runs are excluded: they carry
no mistake classes and their supervisor share (33–89%) inverts the signal of a real run
(14–25%). Live finalize appends stay default-on; `bun run collect` rebuilds the corpus from
the policy, which is how the ledger is regenerated after a policy change.

**D2. A card carries its run's `task`**, the task directory relative to the workspace root
(GLOSSARY: _Task_), so a line can be traced to its run and filtered by it. `collect` stamps it
from the opt-in entry when a card predates the field, since a finished run's `run-details/`
is frozen and cannot be re-derived.

**D3. Attestation re-work is a card metric, not a mistake class.** The card carries
`attestationRounds` and `firstAttestationRoundFailed`, and `trends.md` prints the mean. A
mistake class is binary, and a binary class cannot express a continuous improvement: measured
across three post-mortem runs, rounds went 11 → 4 → 2 while any "did re-work happen" flag fires
on both sides of the split, so the loop would have reported _regressed_. Classes stay binary
and rare; magnitude goes in metrics. A record in `improvements.jsonl` names a class, so this
metric is read in `trends.md` as a per-version mean rather than in the improvement ledger.

**D4. The taxonomy version is not bumped for D3.** Adding a metric does not change what M1–M3
mean, and a bump would isolate the existing corpus: `aggregate` and `measureImprovement` both
filter to a single version, and an unpinned record silently becomes `not yet measurable` the
moment a card of a newer version lands in its window.

**D5. Post-mortem findings that no class can express stay unmeasured.** The destructive
whole-file write, the supervisor's share of tokens, and citation-form drift are none of
M1/M2/M3. They are recorded as gaps rather than forced into a class that would report noise.

## Context

#10 built the loop and closed with one leg unexercised. Exercising it produced these facts:
- The ledger held 25 cards, of which 18 were a single test fixture appending into the
  repository's own ledger (`ab5db9b` fixed the test).
- No card carried a run id or a task, so attributing a card to a run needed a token-total
  match, which collides when two runs tie.
- M1 fires in 3 of 4 post-mortem runs and 0 of 3 smoke runs — the class tracks the task type.
- M2 and M3 never fire in the real corpus, so a change targeting either renders `unchanged`
  whatever it did.
- Attestation rounds, the one metric that did move (11 → 4 → 2, counted by hand from three
  conversations), appears in no class and no card field.

## Alternatives rejected

- **A class for attestation re-work.** It fires on both sides of the improvement and would
  have reported a regression, because the underlying quantity is continuous.
- **One global rate across task types.** The corpus mixes smoke runs and long document runs;
  a shared rate measures the mixture, not the change.
- **Backfilling the metric into finished runs' `scorecard.json`.** A completed run's
  `run-details/` is frozen (AGENTS.md), so the metric starts with the next run.
- **Adding classes before filtering the corpus.** A new class on a mixed corpus adds another
  task-type artifact and, with a version bump, costs the existing cards.

## Revisit when

- The corpus holds runs on both sides of a change within one task type, which is what a real
  rate move needs.
- A "metric" turns out to be binary in use, or a class turns out to need a magnitude.
- A post-mortem finding outside M1–M3 recurs often enough to deserve a class, at which point
  the version bump is deliberate and the existing records get pinned to `1.0`.
