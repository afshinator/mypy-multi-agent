# Analyzer selection: what the pilot measured

Status: evidence from one read-only run. Provenance: task `11-antislop-audit`, HEAD
`9f9ca93`, 2026-10-27, $1.98 spent, no fixes applied. Raw artifacts:
`mypi-tasks/11-antislop-audit/run-details/audit/` (`audit.json`, `raw/`, `sample.json`,
`verification/verifier-verdicts.json`).

This document answers one question: **which analyzers earn a slot in an automated
code-quality workflow, and for what.** It is not a list of tools that exist, and it does
not score tools by their own quality scores.

## Steady state: what to run

| cadence      | tool                                                                     | invocation                                                            | why                                                                            |
| ------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| every change | `tsc`                                                                    | `bun run typecheck` **and** `cd web && bun run typecheck`             | two projects, two programs; the root one does not see `web/`                   |
| every change | `oxlint`                                                                 | `oxlint -f json .`                                                    | 62 ms, the only linter that reports in `scripts/` and reaches `web/`           |
| every change | `biome`                                                                  | `biome check .`                                                       | formatter and import assist; `web/` is excluded by config                      |
| monthly      | `fallow`                                                                 | `fallow dead-code --format json --quiet`                              | unused exports and files; do not run `fallow health` into the report           |
| monthly      | `knip`                                                                   | `knip --reporter json`                                                | `types` only, until a `knip.json` declares the `web` workspace and bin entries |
| monthly      | `aislop`                                                                 | `aislop scan . --json` with `lint`, `format`, `code-quality` disabled | `ai-slop` and `security` are the only engines with unique classes              |
| never        | `jscpd`, `dependency-cruiser`, `dmmulroy/anti-slop`, `typescript-eslint` | —                                                                     | boilerplate clones, no ruleset shipped, no package, redundant with oxlint      |

Anything from the monthly set is a lead, not a defect, until someone reads the code and
adjudicates it.

## Headline

An analyzer's finding count is not a defect count. Of 643 merged findings, the
adjudicated 80-finding sample produced **58 verified, 21 false positives, 1 duplicate**.
Every tool with a high raw count had at least one rule family that was pure noise, and
the highest-value output of the whole run was three reasoned runtime claims no analyzer
can produce — of which only one survived independent reading.

## Measured per tool

| tool          | findings | sampled | verified | false pos | what it actually contributed                                                                  | wall     |
| ------------- | -------- | ------- | -------- | --------- | --------------------------------------------------------------------------------------------- | -------- |
| biome 2.6.2   | 87       | 12      | 12       | 0         | 86 style warnings, all in `test/`; nothing in `src/` or `web/`                                | 322 ms   |
| fallow 3.31.0 | 43       | 11      | 3        | 8         | unused exports/files in `src` and `scripts`; its complexity engine produced most of the noise | 401 ms   |
| tsc 5.9.3     | 0        | —       | —        | —         | type-clean over `src`/`test`/`shared`; no `web/` in the program                               | 3,031 ms |
| knip 6.43.0   | 98       | 15      | 5        | 0         | `types` 5/5 verified; `files`/`exports`/`binaries` 0/10 — entry-point cascades                | 464 ms   |
| oxlint 1.90.0 | 11       | 8       | 7        | 0         | the only executed tool that reports in `scripts/` and `web/`                                  | 62 ms    |
| jscpd 5.4.2   | 376      | 23      | 21       | 2         | clones exist but 246 are in `test/`, 79 YAML boilerplate, 7 generated SVG                     | 94 ms    |
| aislop 0.18.1 | 46       | 17      | 15       | 2         | 2 of its 5 engines carry unique classes; the other 3 duplicate installed tools                | 1,282 ms |

Precision here is sample precision, never population precision. 563 of 643 findings were
never adjudicated.

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

| rule                               | false positives | why                                                                                                                                      |
| ---------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `knip:files`                       | 8               | reports CLI entry points, vite/vitest configs, and `web/` files as unused because no `knip.json` declares entries or the `web` workspace |
| `fallow:crap`                      | 4               | CRAP scores punished short, clear functions with a branch                                                                                |
| `fallow:unused_files`              | 3               | same entry-point problem as knip                                                                                                         |
| `aislop:ai-slop/narrative-comment` | 2               | flagged concise JSDoc as "narrative"                                                                                                     |
| `fallow:cognitive`                 | 1               | complexity threshold on a compact loop                                                                                                   |
| `jscpd:exact`                      | 2               | intra-test-file boilerplate                                                                                                              |

The pattern: **rules that infer intent from structure without knowing the build entry
points produce most of the false positives.** Rules that check a concrete property —
unused import, type error, duplicated type declaration, vulnerable dependency — rarely do.

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
- `fallow dead-code` — the cheapest source of unused-export and unused-file signal. Do not
  run `fallow health` into the report: 5 of the 8 fallow false positives were CRAP or
  cognitive scores.
- `aislop` — run its `ai-slop` engine (duplicated type declarations, double assertions,
  narrative comments) and `security` engine (dependency advisories, injection sinks).
  Disable `lint`, `format`, and `code-quality`: they duplicate oxlint, ruff, fallow, and
  jscpd. That removes 29 of its 46 findings.
- `knip` — for types only. Its `types` family found five real cases of unnecessary public
  surface (unused `AgentBudget`, `PendingRequestFailureSink`, `VersionTrends`; exports used
  only inside their own module). Its `files` and `exports` families are entry-point
  cascades until a `knip.json` declares the `web` workspace and the bin entry points:
  50 of 84 findings were `web/` files labelled unused.

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
  linter, second config.

## Operational rules that decide whether the numbers mean anything

- Sample by rule family, not by category, and make finding ids content-derived: oxlint is
  multi-threaded, so array indices in ids make two runs on the same commit disagree.
- Pin versions outside the scanned tree and invoke by absolute path. Ambient binaries on
  this machine were already two versions different from the repo's pins.
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
- **Advisory applicability is unverified.** `zod` 4.6.5 is a direct dependency; `undici`
  is not — it arrives inside `@earendil-works/pi-coding-agent`. Whether either advisory
  applies to those versions was not checked against an advisory database.
- **One "security" finding was wrong.** aislop's `security/innerhtml` on
  `web/views/plan-findings.ts:22` is a false positive: `web/lib/markdown.ts` constructs
  `new MarkdownIt({ html: false })`, so raw HTML is escaped by design. It was never
  sampled, so nothing adjudicated it before it reached the summary.
- **Model passes are not in the structured artifact.** `audit.json.instruction_reviews`
  is empty; the unguided and Ponytail-guided passes exist only as prose.

## Density

12,473 production TS lines (`src` 8,304 + `shared` 187 + `web` 3,982). 58 verified
findings in the sample over that denominator, split by category: duplication 22,
lint style 11, lint correctness 13, unused/dead 9, ai-pattern 3.
