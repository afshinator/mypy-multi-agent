# Coding standards

The rules a reviewer applies here. Each one is written against a violation that happened, so a rule
with no incident behind it should be deleted rather than obeyed.

A checkable pattern belongs in a check instead: `biome`/`oxlint` for syntax and imports, a guard test
for absence, `test/unit/tracked-reads.test.ts` for files a checkout does not have. What is left below
are the judgement calls no guardrail can decide.

## One authority per rule

A rule lives in one function or module and every caller reaches it: no second copy, no parallel
decision. Two callers needing different shapes is a design decision to record, not a quiet fork.

Eight rules were folded in one pass — `closeRun` (#163), `peerExtensions`/`peerPolicy` (#164),
`runWithRetry` (#165), `TurnState` (#166), `CARD_FIELDS`/`measure` (#167), `verifyAudit` (#169),
`decidingVerdicts` (#170) — and each landed with a test that fails if the copy returns.

Three enforcement shapes are acceptable: assert the symbol is absent from the file it left
(`test/unit/turn-state.test.ts`), pin the order the one owner writes in
(`test/unit/closing-record.test.ts`), or drive the single entry point and assert every caller's
behaviour through it.

## A seam exists in production

An injectable parameter, branch or fake must sit on the path production takes. A seam reachable only
from a test hides the class of bug it was added to catch.

#225: the tracker's `Exec` carried a `stdin` parameter that only the fake used. Production posted with
`gh api -f body=@-`, which does not read stdin, so every comment body was the literal `@-` and no test
could see it. The parameter was deleted rather than repaired.

## Absent is not zero

A value nobody recorded is unmeasured. Reporting it as `0` invents a measurement nobody made, and no
reader can tell the two apart afterwards.

#167: two scorecard denominators looked inconsistent because an absent re-work figure was being counted
as zero. Both were dividing by 2 over rows that skip absent fields; the fix was to state the rule
(absent = skipped) once in `src/scorecard/measure.ts`, not to reconcile the numbers.

## Refuse before spending

Validation that can run before an expensive step runs before it: a model call, a clone, a workspace, a
ticket write. A refusal landing after the spend is still a defect when the check was knowable earlier.

#177: `run` refused a task dir that already held `run-details/final.md` only after copying
`node_modules` and opening a workspace. The guard now runs first (`src/batch/executor.ts:210`), and
`prepare` refuses `kind-invalid` and `manifest-invalid` before the verifier call for the same reason.

## Comment the why

One line on the reason the code cannot show: an ordering that looks arbitrary, a timestamp skew, a flag
whose help text lies. #177: `MTIME_SKEW_MS = 2000` exists because the CI runner's overlay filesystem
reports coarser timestamps than the launch millisecond. A comment restating the code is noise; a comment
carrying a measurement is the only record that it was ever measured.
