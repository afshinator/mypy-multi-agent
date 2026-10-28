# Analyzer selection: what the pilot measured

Status: evidence from one read-only run. Provenance: task `11-antislop-audit`, HEAD
`9f9ca93`, 2026-10-27, $1.98 spent, no fixes applied. Raw artifacts:
`mypi-tasks/11-antislop-audit/run-details/audit/` (`audit.json`, `raw/`, `sample.json`,
`verification/verifier-verdicts.json`).

This document answers one question: **which analyzers earn a slot in an automated
code-quality workflow, and for what.** It is not a list of tools that exist, and it does
not score tools by their own quality scores.

## Steady state: what to run

| cadence      | tool                                                                     | invocation                                                                     | why                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| every change | `tsc`                                                                    | `bun run typecheck` **and** `cd web && bun run typecheck`                      | two projects, two programs; the root one does not see `web/`                                                                                |
| every change | `oxlint`                                                                 | `oxlint -f json .`                                                             | 62 ms, the only linter that reports in `scripts/` and reaches `web/`                                                                        |
| every change | `biome`                                                                  | `biome check .`                                                                | formatter and import assist; `web/` is excluded by config                                                                                   |
| monthly      | `fallow`                                                                 | `fallow dead-code --format json --quiet`                                       | unused exports and files; do not run `fallow health` into the report                                                                        |
| monthly      | `knip`                                                                   | `knip --reporter json`                                                         | `types` only, until a `knip.json` declares the `web` workspace and bin entries                                                              |
| monthly      | `aislop`                                                                 | `aislop scan . --json` with `lint`, `format`, `code-quality` disabled          | `ai-slop` and `security` are the only engines with unique classes                                                                           |
| monthly      | `ruff` (pinned, not via aislop)                                          | `ruff check --no-cache --output-format json .`                                 | the only Python lint in the set: keep F401/UP045/UP017, BLE001 warning tier, EXE001 low, I001/F541 autofix, suppress B008 on FastAPI routes |
| monthly      | `oxlint --type-aware`                                                    | `oxlint --type-aware -f json .` with the toolchain `node_modules/.bin` on PATH | the only measured signal on defects the syntactic stack cannot see; one rule pays                                                           |
| never        | `jscpd`, `dependency-cruiser`, `dmmulroy/anti-slop`, `typescript-eslint` | —                                                                              | boilerplate clones, no ruleset shipped, no package; typed eslint only duplicates it                                                         |

Every row above has an adjudicated sample behind it: findings from that tool were read against
the code and scored on validity, actionability and consequence, on at least one repo. A tool
without that is not in the table.

### Provisioned, no verdict yet

`mypy` 2.4.0 and `bandit` 1.9.4 are pinned, hashed and measured once, but **no sample from
either has been adjudicated**, so neither earns a cadence. What the narrative-nexus run showed:
- `mypy` returned 3 diagnostics and exited 2. One file in that tree
  (`scripts/v1_concurrency_test.py:6`) is not valid Python, and mypy has no
  continue-past-syntax-error mode, so it stopped there. A type baseline that any single
  unparseable file can zero out is measuring the tree's parseability, not its types.
- `bandit` returned 739 findings, 677 of them B101 `assert_used` in test files. Removing that
  rule leaves 62 (B608 string-built SQL 23, B306 `mktemp` 18, B310 urlopen 6, B108 5, B311 3,
  B404 1) — small enough to adjudicate in one pass.

Both are candidates. Promoting either needs what ruff got: a rule-level sample read against the
code.

Provisioning is two installers into one prefix: bun for the seven npm analyzers, uv for the
three PyPI ones (`mypy` 2.4.0, `bandit` 1.9.4, `ruff` 0.17.3). The npm names `mypy`, `bandit`
and `ruff` are unrelated projects with no `bin` entry, so the Python tools cannot be pinned
through `package.json`. `provision.sh --verify` hashes all ten binaries.

Anything from the monthly set is a lead, not a defect, until someone reads the code and
adjudicates it.

Visual summary of the measured numbers:
[`pilot-findings.svg`](./pilot-findings.svg).

## Headline

An analyzer's finding count is not a defect count. Of 643 merged findings, the
adjudicated 80-finding sample produced **58 verified, 21 false positives, 1 duplicate**.
Every tool with a high raw count had at least one rule family that was pure noise, and
the highest-value output of the whole run was three reasoned runtime claims no analyzer
can produce — of which only one survived independent reading.

Those 80 came from a category-keyed pass. A second pass re-adjudicated the 49 rows that
the corrected rule-family sample drew for `fallow` and `aislop` (task
`12-antislop-remeasure`), with two models judging the same rows independently and
byte-identical prompts: **31 verified, 17 false positive, 1 duplicate**. The rate column
below is from that pass wherever one exists, because it samples every rule family rather
than every category.

## Measured per tool

| tool          | findings | sampled | verified | false pos | rule-family rate | what it actually contributed                                                             | wall     |
| ------------- | -------- | ------- | -------- | --------- | ---------------- | ---------------------------------------------------------------------------------------- | -------- |
| biome 2.6.2   | 87       | 12      | 12       | 0         | pass 1           | 86 style warnings, all in `test/`; nothing in `src/` or `web/`                           | 322 ms   |
| fallow 3.31.0 | 43       | 11      | 3        | 8         | **10/23 (43%)**  | unused exports and unlisted deps hold; `crap`/`cognitive`/`unused_files` are 0 of 11     | 401 ms   |
| tsc 5.9.3     | 0        | —       | —        | —         | —                | type-clean over `src`/`test`/`shared`; no `web/` in the program                          | 3,031 ms |
| knip 6.43.0   | 98       | 15      | 5        | 0         | **5/15 (33%)**   | `types` 5/5 verified; `files`/`exports`/`binaries` 0/10 — entry-point cascades           | 464 ms   |
| oxlint 1.90.0 | 11       | 8       | 7        | 0         | pass 1           | the only executed tool that reports in `scripts/` and `web/`                             | 62 ms    |
| jscpd 5.4.2   | 376      | 23      | 21       | 2         | pass 1           | clones exist but 246 are in `test/`, 79 YAML boilerplate, 7 generated SVG                | 94 ms    |
| aislop 0.18.1 | 46       | 17      | 15       | 2         | **21/26 (81%)**  | its 81% rides on rules that duplicate other tools; its unique `ai-slop` rules are 2 of 5 | 1,282 ms |

Precision here is sample precision, never population precision. 563 of 643 findings were
never adjudicated, and the 49 re-adjudicated rows were not a random draw across all tools.

**Second repo (finance-hub, Next.js + npm, 36k TS/TSX LOC + 3.6k Python, 120 rows
adjudicated on three dimensions):** the per-tool verdicts held, with one relabelling worth
knowing. `fallow unused_files` was 4/4 `absent` (pilot: 3/3 false positive) — noise on both
repos, different entry-point stories. `fallow crap` was 5/5 `present` but 5/5 actionability
`none` and consequence `low`: the rule is right and useless, where the pilot had called it a
false positive. `knip types` held at 1/1. `biome` produced 702 in-scope findings, dominated
by format, import ordering and two lint rules, all adjudicated present-and-not-worth-fixing:
a formatter, not an auditor. `jscpd` stayed precise and worthless. `tsc` produced 12
`TS2345` in test files only.

## Where each tool actually looked

Measured distribution of findings by top-level directory. A gap in this table is a tool
that did not report there, which is not the same as a directory being clean.

| tool   | dirs with findings                                                                           |
| ------ | -------------------------------------------------------------------------------------------- |
| biome  | `test/` 86, `docs/` 1 — nothing in `src/`, `web/`, `scripts/`                                |
| fallow | `src/` 19, `scripts/` 18, `docs/` 2, `test/` 2, `shared/` 1                                  |
| knip   | `web/` 50, `src/` 22, `scripts/` 11, `shared/` 1                                             |
| oxlint | `test/` 6, `scripts/` 3, `src/` 2 — scanned 51 `web/` files, found none                      |
| aislop | `src/` 14, `scripts/` 11, `docs/` 9, `web/` 6, `package.json` 2                              |
| jscpd  | `test/` 246, `mypi-tasks/` 70, `scripts/` 27, `templates/` 13, `docs/` 8, `web/` 7, `src/` 4 |

The repo's own configuration silently narrows this further: `biome.json` excludes `web/`
and `scripts/bun-s4-probe/`; `.fallowrc.json` ignores the same two; root `tsconfig.json`
includes only `src`, `test`, `shared`. Three tools therefore never see `web/` unless
someone changes their config, and `web/` is 51 source files plus a 3,982-line TS surface.

## Which rule families lie

False positives by rule, measured:

| rule                                        | false positives | why                                                                                                                                      |
| ------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `fallow:crap`                               | **5 of 5**      | CRAP scores punished short, clear functions with a branch                                                                                |
| `fallow:cognitive`                          | **3 of 3**      | complexity threshold on flat code and a compact loop                                                                                     |
| `fallow:unused_files`                       | **3 of 3**      | entry points: `bun rasterize.ts` per its README, `scripts/fault-inject.ts` per the justfile                                              |
| `knip:files`                                | **0 of 5** (8)  | reports CLI entry points, vite/vitest configs, and `web/` files as unused because no `knip.json` declares entries or the `web` workspace |
| `aislop:ai-slop/narrative-comment`          | **2 of 2**      | flagged concise JSDoc as "narrative"                                                                                                     |
| `aislop:ai-slop/duplicate-type-declaration` | **1 of 1**      | the `web/lib/scorecard.ts` mirror is documented as deliberate at lines 3-5                                                               |
| `jscpd:exact` (pass 1)                      | 2 of 23         | intra-test-file boilerplate — precise and worthless, a different failure mode                                                            |

Bold counts are from the rule-family pass, where the family was sampled exhaustively; the
parenthetical is the pass-1 count. The pattern: **rules that infer intent from structure
without knowing the build entry points, or that score readability, produce nearly all the
false positives.** Rules that check a concrete property — unused import, type error,
vulnerable dependency, identical clone — rarely do, but a concrete property can still be
irrelevant: the duplicate type declaration is real and deliberately maintained.

## Rates are only as good as the blindness

The second repo adjudicated 120 findings twice with identical prompts: validity agreed on
102 of 120 rows, and on 57 of those the two peers still differed on actionability or
consequence. Re-judging 20 rows with the tool and rule names removed flipped **13 of 20**,
including 3 validity calls. So:
- a per-family **validity** count from one adjudicator is reasonably stable;
- a per-family **actionability or consequence** call is one opinion;
- any per-family _rate_ computed without blindness is a description of a reconciled reading,
  not a precision measurement. Blinding is the control — `scripts/antislop/blind.ts` — and if
  it flips more than roughly a tenth of rows, quote counts, not rates.

## What the gates are actually for

Ten sampled bugfix commits from this repo were judged for whether any enabled rule family
could have seen the defect (`mypi-tasks/14-recall-coverage/`): **two qualified**. Unsorted
imports and a dead export — shape. The other eight were behavioural: a rejection never
observed, an accounting boundary lost on resume, a predicate computed and discarded, bash
classified read-only while it mutates.

So read the gates' silence correctly: `tsc`, `oxlint` and `biome` passing means the code is
well-formed, not that it is correct. Two consequences worth acting on:
- **Do not buy more analyzers to catch this class.** No rule id in the vocabulary of seven
  tools encodes an invariant across time or an ordering assumption. Coverage of behavioural
  defects comes from tests and review, not from the audit.
- **One cheap upgrade exists:** a floating-promise rule — biome 2.x's nursery
  `noFloatingPromises`, or `oxlint --type-check` for the type-aware set. Enabled, it would
  have seen the deferred-rejection fix in that sample. Everything else the readers found was
  outside any rule's field of view even in principle.

## Two kinds of signal, not interchangeable

- **Deterministic analyzers** are cheap, repeatable, and diffable. They are the only
  source that can gate a change, because two runs on the same commit agree.
- **Model review** produced the only findings that require understanding behaviour:
  a deliberate session stop logged as `correlation-timeout` (real, verified at both ends
  of the chain: `src/runtime/correlation-registry.ts:64` rejects with a plain `Error`,
  `src/runtime/runtime.ts:527,545` classifies anything that is not `PeerTerminalError` as
  a timeout, `src/scorecard/scorecard.ts:153` counts it); a dispatch that cannot confirm
  delivery (`src/runtime/runtime.ts:486-491` checks `link.has()` then calls a `void`
  `emit()`); and an unbounded `await settled` (`src/peer/peer-session.ts:171`) that is
  plausible but unproven.

Model review also missed what the analyzers caught: it read `package.json` and still ran
no dependency check, and it under-reported one duplicated contract. The two methods are
complementary, and neither substitutes for the other.

## Selection rules

**Use as gates (deterministic, low noise, cheap):**
- `tsc --noEmit` — correctness baseline over `src`/`test`/`shared`/`scripts`. `web/` is a
  separate project with its own config and its own `typecheck` script, so the root command
  never sees it; web is type-checked only when you run `cd web && bun run typecheck`. 3 s,
  and its silence means "no type error", nothing more.
- `oxlint -f json` — fastest signal available (62 ms), only tool reporting in `scripts/`.
  Default rule set is correctness-only; add plugins deliberately.
- `biome check --reporter=json` — keep for the formatter and import assist. As an audit
  signal in this repo it contributed one style rule in `test/`.

**Use for periodic audits, with a filter:**
- `fallow dead-code` — the cheapest source of unused-export signal: `unused_exports` 2/2 and
  `unlisted_dependencies` 1/1 verified. From `health`, run only `cognitive_crap` (3/3).
  Drop `crap` (0/5), `cognitive` (0/3) and `unused_files` (0/3) — those three families are
  the whole false-positive population of the tool.
- `aislop` — run the `security` engine and two rules out of `ai-slop`:
  `double-type-assertion` (1/1) and `unused-import` (1/1). Drop
  `narrative-comment` (0/2) and `duplicate-type-declaration` (0/1). Disable `lint`,
  `format`, and `code-quality`: they duplicate oxlint, ruff, fallow, and jscpd. That
  removes 29 of its 46 findings. Their precision is high and largely tautological — "this
  function is 88 lines" is a measurement, verified by definition — so redundancy, not
  accuracy, is the reason to leave them out. `ruff` is the one exception to note: it is the
  only thing installed that lints Python, and on the n=3 Python-majority repo (15,743 LOC) it
  earns a permanent slot — rule by rule. Keep F401 (dead imports), UP045 and UP017 (mechanical
  PEP-604 / `datetime.UTC` modernization), BLE001 (warning tier: 5/5 genuine blind excepts, 4/5
  deliberate in probe scripts), EXE001 (low: shebang with no `+x`), and I001/F541 (autofix only).
  Suppress B008 on FastAPI route modules — its remedy breaks dependency injection at every sampled
  line. The two `hallucinated-import` false positives (the `newspaper4k` import-name rows) are the
  only Python misses on the sample.
- `knip` — for types only. Its `types` family found five real cases of unnecessary public
  surface (unused `AgentBudget`, `PendingRequestFailureSink`, `VersionTrends`; exports used
  only inside their own module). Its `files` and `exports` families are entry-point
  cascades until a `knip.json` declares the `web` workspace and the bin entry points:
  50 of 84 findings were `web/` files labelled unused.

- `oxlint --type-aware` — the one axis that reaches past shape (task
  `15-type-aware-adjudication`, finance-hub, 149 distinct findings, 36 adjudicated on three
  dimensions). Run it instead of a typed eslint setup: restricted to the same six rules it
  agrees with a pinned eslint 10 + `typescript-eslint` `projectService` profile on all 144
  findings both engines report, and it needs no authored config. It needs `oxlint-tsgolint`
  (oxlint 1.90's own peer range) and the toolchain's `node_modules/.bin` **on PATH** — oxlint
  looks there, not in its own `node_modules`. Only `typescript/no-unnecessary-condition`
  clears the anecdote line: 6 of its 8 sampled findings were material, and six of those share
  one mechanism — a type that overstates what the data guarantees, so the fallback the rule
  calls dead is load-bearing (`as string`/`as number` over unvalidated API JSON, destructures
  from asserted arrays). The rest was marginal or worthless: `no-misused-promises` 0 of 5,
  `no-floating-promises` 1 of 5, `no-base-to-string` 1 of 5, `no-redundant-type-constituents`
  1 of 4, `await-thenable` 2 of 4, `restrict-template-expressions` 0 of 4 (two duplicates),
  `unbound-method` 0 of 1. Nothing was high consequence and no row was a bug that happened,
  so this buys an honest type-lie pass, not defect prevention. If you run the eslint route
  anyway, the profile must declare every plugin the repo's `eslint-disable` directives name:
  otherwise the run reports 28 unused directives and 6 undefined-rule messages as findings.

**Before any of it: declare scope.** A repo that tracks generated or fixture trees
(`data/`, `graphify-out/`, agent config dirs, lockfiles) will be measured wrong unless those
paths are excluded before collection: on finance-hub, jscpd produced 612 of 774 findings and
biome 720 of 2,142 in trees that are not app source. Pass them to the collector
(`collect.ts --ignore '**/data/**,…'`); findings a tool reports anyway are marked
`out_of_scope` and never enter the sample.

**Do not use:**
- `jscpd` for TS/JS repos. 376 clones: 246 in `test/`, and of the 95 non-TS clones, 79
  were `mypi-tasks/*/session.yaml` boilerplate and 7 were base64 inside generated SVG.
  It costs a 43 MB per-platform binary for that.
- `dependency-cruiser` without an authored ruleset. It exits 1 with `Can't open a config
  file`; `--no-config` produced 1,299 modules and 20 "circular" findings, all inside
  `node_modules`.
- `dmmulroy/anti-slop` as a package: there is none. It is a vendored oxlint plugin pinned
  to `oxlint 1.78.0`, and its `no-reflect-apply` contradicts `unicorn/prefer-reflect-apply`.
- `typescript-eslint` type-aware rules alongside `oxlint --type-check`: same axis, second
  linter, second config. **This call is still inherited, not measured on either repo.** It
  was deferred on a repo with no eslint installed; finance-hub already ships eslint 9 +
  `eslint-config-next` and a type-aware config, where the redundancy argument inverts.
  Re-test tracked as issue #115.

## Operational rules that decide whether the numbers mean anything

- Sample by rule family, not by category, and make finding ids content-derived: oxlint is
  multi-threaded, so array indices in ids make two runs on the same commit disagree.
- Pin versions outside the scanned tree and invoke by absolute path. Ambient binaries on
  this machine were already two versions different from the repo's pins. Provisioning is
  bun-only by design (it hashes platform binaries); the scanned repo may use npm, pnpm or
  yarn — only lockfile _resolution_ cares, and that is per-format.
- Hash the platform executable, not the `node_modules/.bin` shim — the shim is a Node
  wrapper over a Mach-O binary.
- A findings-heavy exit code is data. `knip`, `fallow`, `aislop` exit 1 on findings;
  `jscpd` only with `--exit-code`; `oxlint` only with `--deny-warnings`.
- Three analyzers write into the tree they analyze: `fallow` (`.fallow/cache.bin`),
  `aislop` (`.ruff_cache/`), `jscpd` (`./report/` when `-o` is omitted). Declare those
  writes or they look like tampering.
- `jscpd` needs `-o` outside the source tree; `aislop` needs
  `AISLOP_NO_TELEMETRY=1 AISLOP_NO_UPDATE_NOTIFIER=1 AISLOP_NO_HISTORY=1`.

## What this run does not establish

- **Recall is unmeasured.** No labelled defect set exists. 643 findings are what seven
  tools noticed, not the set of defects.
- **Knip's `exports` family after configuration.** The sampler now reaches it, and the
  three sampled verdicts were false positives caused by undeclared entry points; whether
  it becomes useful once they are declared is untested.
- **Advisory applicability is unverified.** `zod` 4.6.5 is a direct dependency;
  `undici` 8.10.2 is not — it arrives inside `@earendil-works/pi-coding-agent`. The
  collector now resolves both from whichever lockfile the repo has (`bun.lock` or
  `package-lock.json`, recording which) and attaches it to the finding, so the installed
  version no longer has to be read out by hand. Resolution is still not verification:
  whether either advisory applies to those versions was not checked against an advisory
  database, and the GHSA ids and "fixed in" versions quoted in the pilot's artifacts are
  not in the reporter output.
- **pnpm and yarn lockfiles resolve to null, deliberately.** The resolver was written
  against real `bun.lock` and `package-lock.json` files and has no sample for the other
  two formats, so it reports nothing rather than guessing a parse.
- **One "security" finding was wrong.** aislop's `security/innerhtml` on
  `web/views/plan-findings.ts:22` is a false positive: `web/lib/markdown.ts` constructs
  `new MarkdownIt({ html: false })`, so raw HTML is escaped by design. It was unsampled in
  the first pass and read as FP in the second, so it stands as the example of why a
  security hit is a lead until someone opens the file.
- **Model passes are not in the structured artifact.** `audit.json.instruction_reviews`
  is empty; the unguided and Ponytail-guided passes exist only as prose.

## Density

12,473 production TS lines (`src` 8,304 + `shared` 187 + `web` 3,982). 58 verified
findings in the sample over that denominator, split by category: duplication 22,
lint style 11, lint correctness 13, unused/dead 9, ai-pattern 3.

Read that split with one caveat: `unused/dead 9` contains aislop's `code-quality` engine
(`function-too-long`, `file-too-large`, `duplicate-block`) because the normalizer filed that
engine under the unused category — fixed afterwards, not re-collected — so the split has
no complexity row at all. By
family, the complexity signal is aislop 5 of 5 (a size measurement) and fallow 0 of 8 (a
readability score). The number to quote from this run is the actionability density, not
the total: duplication is 71% of verified findings and almost none of it should be fixed.
