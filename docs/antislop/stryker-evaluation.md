# Mutation testing — StrykerJS

**Verdict.** Keep, as an on-demand tool scoped to the modules whose behavior matters. Never in
`check`: a full run is ~4 minutes and its output is 100 advisories that a human must read, not a
pass/fail. It is the only tool in the set that measures whether a test would catch a behavior
change, and that question is invisible to every analyzer the audit already runs.

Provenance: HEAD `0672395` plus this working tree's Stryker config, 2026-10-30,
`@stryker-mutator/core` 10.1.1, `@stryker-mutator/vitest-runner` 10.1.1, vitest 5.0.3,
`concurrency: 4`, no model spend. Command: `bun run mutate`.

## What is committed

| file                        | role                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `stryker.conf.json`         | the curated `mutate` list, `coverageAnalysis: "all"`, `vitest.related` |
| `vitest.mutation.config.ts` | the real suite minus `test/unit/extension-launch.test.ts`              |
| `package.json`              | two dev deps, `mutate` script                                          |
| `.gitignore`                | `.stryker-tmp/`                                                        |

`test/unit/extension-launch.test.ts` calls `process.chdir()`, which throws under the worker pool
Stryker's coverage analysis requires. It is the only exclusion. If that test stops calling
`process.chdir()`, delete the exclusion — otherwise the mutation run silently measures a different
suite than `bun run test`.

Per-module filtering is `vitest.related`, not a test list: each mutant runs the test files that
reach the mutated file, which averaged 18.2 tests per mutant over this set.

## Scores

436 mutants, 331 killed, 100 survived, 5 no-coverage, 3m50s.

| module                                | mutants | killed  | survived | no cov | score      |
| ------------------------------------- | ------- | ------- | -------- | ------ | ---------- |
| `src/bus/message-validator.ts`        | 19      | 18      | 1        | 0      | 94.74%     |
| `src/contracts/criteria.ts`           | 25      | 20      | 4        | 1      | 80.00%     |
| `src/runtime/correlation-registry.ts` | 32      | 24      | 8        | 0      | 75.00%     |
| `src/scorecard/scorecard.ts`          | 225     | 179     | 45       | 1      | 79.56%     |
| `shared/turn.ts`                      | 135     | 90      | 42       | 3      | 66.67%     |
| **total**                             | **436** | **331** | **100**  | **5**  | **75.92%** |

## The 100 survivors, adjudicated

Each survivor's source line was read. Four were then re-checked by applying the mutation by hand
and running the covering tests: all four still pass, so the gap is in the assertions, not in the
mutation harness.

| class                 | survivors | meaning                                                         |
| --------------------- | --------- | --------------------------------------------------------------- |
| real gap, consequence | **35**    | behavior changes, nothing fails, and it matters                 |
| real gap, negligible  | **37**    | behavior changes, only diagnostics, ordering or malformed input |
| equivalent            | **28**    | no test can distinguish it; the same result is reached anyway   |

The `NoCoverage` 5 split 3 real gap, 2 equivalent.

So the honest score is **82.1%**, not 75.92%: removing the 28 equivalents gives
331 / (331 + 35 + 37).

### What the equivalents are

They are not random. Two shapes account for most of them:
- `typeof x === "number" && Number.isFinite(x)` — the second clause can only be true inside the
  first. Same for `typeof v === "object" && v !== null` where every caller then uses `?.` or `??`.
- `x !== undefined` after a `typeof x === "string"` ternary has already excluded `undefined`.

Verified single case: `src/contracts/criteria.ts:25` `if (!match) return undefined` → `if (false)`
survives because the resulting `TypeError` from `match[1]` lands inside the existing `try` and
returns `undefined` anyway.

Any strict-TypeScript tree with defensive guards will produce this class. Budget the reading pass,
not the run.

## The 35 real gaps, by site

### `src/scorecard/scorecard.ts` — 23 mutants, 14 lines

The whole alarm and accounting surface of a scorecard is thinly asserted:

| site       | mutation that survives                                                | consequence                                           |
| ---------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| `:212`     | `falseSuccess = exitCode === 0 && dod === "unmet"` loses the DoD half | the false-success alarm fires on a met run            |
| `:211`     | both null guards and `successOutcome !== successExit`                 | issue #119's mismatch check has no boundary test      |
| `:198`     | the `e.type === "ERROR" && e.event === "correlation-timeout"` pair    | every ERROR is counted as a correlation timeout       |
| `:183`     | `duration === null \|\| duration < 0` → `&&`                          | a null duration reaches the sum as `NaN` (verified)   |
| `:149`     | the `e.sender !== attester` filter in attestation rework              | any peer's verdict block counts toward rework rounds  |
| `:125`     | the same filter in `attestedVerdicts`                                 | a non-attester's block decides `dod`                  |
| `:124`     | `e.type !== "RESPONSE" && e.type !== "FINAL_REPORT"` as `===`         | no test attests through a FINAL_REPORT alone          |
| `:148`     | the same filter in the rework counter                                 | rework rounds are never counted for FINAL_REPORT      |
| `:181`     | `if (t.isError === true) toolErrors++`                                | the tool-error counter is never exercised with `true` |
| `:113`     | `normalizeOutcome`'s `"aborted"` arm                                  | an aborted run is scored as `unknown`                 |
| `:100-105` | four of the six `STOP_AGENT_REASON_CODES`                             | those reasons normalize to `"other"`                  |

### `src/runtime/correlation-registry.ts` — 7 mutants, 4 functions

Deleting `waiters.delete(...)` in the timeout handler, `resolve`, `failWith` and `failAll`, and
`clearTimeout` in the same four places, changes nothing that any test observes. The map is never
asserted empty after a resolve; `hasWaiter()` after a resolve is untested; the file's own header
("a late or duplicate resolve/fail is a safe no-op") is unenforced. `resolve` and `failAll` were
verified by hand: tests pass with the bookkeeping deleted.

### `shared/turn.ts` — 7 mutants, 6 lines

| site         | mutation that survives                           | consequence                                                                          |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `:26`        | the `typeof taskId === "string"` guard           | the documented "id-less entries are skipped" is untested; they pair as `t:undefined` |
| `:25`        | `payload?.taskId` → `payload.taskId`             | a payload-less entry throws inside `turnDurations`                                   |
| `:62`        | `.slice()` removed before `.sort()`              | the caller's array is sorted in place, contradicting "no mutation of inputs"         |
| `:67`        | `if (list === undefined) … else list.push(c.ts)` | a second close for one key overwrites the first                                      |
| `:64`, `:68` | two closes for one agent                         | that branch has no coverage at all                                                   |

### `src/contracts/criteria.ts` — 1 mutant

`:10` the `z.enum(["pass", "fail"])` member: no test parses a **failing** verdict through
`parseCriteriaBlock`. The passing path is the only one exercised.

## General use: what to expect in another repo

- **Noise is predictable.** Around 28% of survivors were equivalents, concentrated in the guard
  shapes above. A repo without strict null checks or without defensive `typeof` guards will show
  fewer, but any TS repo with a validation boundary will show some.
- **The yield is not the percentage.** 35 of 100 survivors mattered, on 28 distinct source lines. The list
  above is the deliverable; the score is a bookmark.
- **Cross-repo and cross-module percentages are not comparable.** 66.67% and 94.74% differ partly
  on how many guard-equivalents a module contains, not only on test quality.
- **Cost.** 10–25 s per small module, ~4 min for this five-module set at concurrency 4. The
  human reading pass for 100 survivors is the real cost. Keep the set small and re-read only
  survivors whose mutants are not in the equivalent shapes.
- **Gate policy that survives contact.** Do not gate on a global threshold. Gate on "the diff's
  modules have no new real gap", or keep a per-module floor and re-baseline deliberately. A
  global percentage invites tuning the number instead of the tests.
- **Integration cost per repo.** One config file, one vitest config file, and an exclusion for any
  test that depends on the process working directory, `process.chdir()`, or a global port.

## Limits of this measurement

- One adjudicator, unblinded: the 35 / 37 / 28 split is a reading, not the three-dimension
  blind-adjudicated sample the analyzer table uses. A second independent read would move rows
  between the two real-gap bands, not into the equivalent band.
- Five modules, chosen because their behavior matters, not sampled from the tree. Nothing here
  says anything about the other ~250 files.
- `vitest.related` maps a test to a mutant through the static import graph. A test that reaches a
  module only through a dynamic import would be missed, and its mutant would be reported
  survived.
- The 5 `NoCoverage` mutants are the only claim that reads "no test reaches this line". All other
  survivors had at least one covering test that ran and passed.
