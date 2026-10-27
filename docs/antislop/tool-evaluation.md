# Analyzer evaluation (pilot evidence)

Deliverable for issue #106. Guidance layer: [`tool-selection.md`](./tool-selection.md).
Evidence layer: this file. Everything here is derived from the completed pilot run —
task `11-antislop-audit`, HEAD `9f9ca93`, 2026-10-27, `$1.98`, no fixes applied.
Artifacts: `mypi-tasks/11-antislop-audit/run-details/audit/`. Visual summary:
[`pilot-findings.svg`](./pilot-findings.svg).

## Method, and where it bends

- 661 raw findings across 7 executed analyzers, merged to 643 by
  `(path, line bucket, category)`. 80 sampled, stratified by `(tool, category)`,
  `max(5, 10%)` per stratum under an 80 cap. All 80 adjudicated against source:
  **58 verified, 21 false positive, 1 duplicate, 0 inconclusive**. 563 unreviewed.
- **Adjudication** means opening the code a finding names and deciding one of four
  verdicts: `verified` (the claimed problem is really there), `false_positive` (the tool
  is wrong), `duplicate` (another finding already covers it), or `inconclusive` (the code
  does not settle it). A rule hit is never treated as a defect until a human or agent has
  read the code; the per-finding verdicts and their evidence references are stored in
  `verification/verifier-verdicts.json`.
- Precision below is **sample precision**, never population precision. Because the
  allocation is deliberately non-proportional, a plain count over the sample would
  misstate the repo. The population figures use the standard stratified estimator
  `Σ (verified/sampled) × frame`: **≈484 verified, ≈158 false positive, ≈1 duplicate**.
- The estimator is only as good as the strata. The first run keyed strata by category,
  which collapsed knip's four rule families (`files`, `binaries`, `exports`, `types`)
  into one stratum and never sampled the last two. That defect is fixed (see
  "Sampler correction") and knip has now been measured.
- **Second pass (task `12-antislop-remeasure`).** The 49 rows the corrected rule-family
  sample drew for `fallow` (23) and `aislop` (26) were adjudicated again, because the
  per-tool rates above came from the category-keyed pass. Both adjudicators returned
  49/49 verdicts from byte-identical prompts with no mutual visibility; they agreed on
  29 rows and split on 20, and every split was resolved against the code. Reconciled:
  **31 verified, 17 false positive, 1 duplicate, 0 inconclusive**. Because every
  fallow/aislop row of that sample was adjudicated, the family rates below are complete
  for those two tools, not a subsample of them.

## Per tool

| tool   | raw | merged | n   | verified | FP  | est. verified | rule-family sample | actionability                                          | wall     | verdict                         |
| ------ | --- | ------ | --- | -------- | --- | ------------- | ------------------ | ------------------------------------------------------ | -------- | ------------------------------- |
| biome  | 87  | 87     | 12  | 12       | 0   | 87            | pass 1             | low — test-file style plus one format error on a doc   | 322 ms   | keep as gate                    |
| fallow | 43  | 43     | 11  | 3        | 8   | 7             | **10/23 (43%)**    | medium — dead-code half only                           | 401 ms   | keep `dead-code`, drop `health` |
| tsc    | 0   | 0      | —   | —        | —   | —             | —                  | baseline only                                          | 3,031 ms | keep as gate                    |
| knip   | 98  | 84     | 15  | 5        | 0   | 17            | **5/15 (33%)**     | `types` only — 5/5 verified unnecessary public surface | 464 ms   | keep `types`, configure entries |
| oxlint | 11  | 11     | 8   | 7        | 0   | 10            | pass 1             | medium — only tool reporting in `scripts/`             | 62 ms    | keep as gate                    |
| jscpd  | 376 | 376    | 23  | 21       | 2   | 343           | pass 1 (38 drawn)  | **low** — verified clones are boilerplate              | 94 ms    | drop                            |
| aislop | 46  | 42     | 17  | 15       | 2   | 36            | **21/26 (81%)**    | `ai-slop` + `security` only, see below                 | 1,282 ms | keep 2 of 5 engines             |

`n`/`verified`/`FP` are the first-pass sample; `est. verified` is the first-pass
stratified estimate and is what the Density table below sums. The rule-family column is
the re-measured rate from the second pass, and it is the number to use in a keep/drop
decision. No population estimate is recomputed from the second pass: its strata frames
for fallow sum to 27 against a population of 43, so the frames describe a filtered run,
not the full family population. `est. verified` for aislop counts its Python verdicts
too; the relevant subset is 4. See the aislop section.

## Where the numbers mislead, tool by tool

**biome — 100% precision, little value.** All 12 sampled verdicts were in `test/`: 9
`noNonNullAssertion`, 2 `noExplicitAny`, 1 `noIdenticalTestTitle`. Its 87th finding is a
format diff on `docs/antislop/workflow.md`. Nothing in `src/`, nothing in `web/` (excluded
by config). It is a formatter and a new-code gate; it is not an audit instrument here.

**fallow — the dead-code half holds, and the health half splits three ways.** Re-measured
on all 23 sampled fallow findings:

| family                  | sampled | verified | false positive | verdict                         |
| ----------------------- | ------- | -------- | -------------- | ------------------------------- |
| `unused_exports`        | 2       | 2        | 0              | keep                            |
| `unlisted_dependencies` | 1       | 1        | 0              | keep                            |
| `code-duplication`      | 1       | 1        | 0              | keep as a lead, not a work item |
| `cognitive_crap`        | 3       | 3        | 0              | keep                            |
| `both`                  | 3       | 2        | 1              | mixed                           |
| `all`                   | 2       | 1        | 1              | mixed                           |
| `crap`                  | 5       | 0        | 5              | drop                            |
| `cognitive`             | 3       | 0        | 3              | drop                            |
| `unused_files`          | 3       | 0        | 3              | drop                            |
| **total**               | **23**  | **10**   | **13**         | **43%**                         |

So the split is not "dead-code good, health bad": it runs _inside_ health, where
`cognitive_crap` verified 3 of 3 while `crap` and `cognitive` verified none of 8. Read at
the cited lines, every `crap`/`cognitive` verdict was flat code — `sanitizeCost`,
`sanitizeRecord`, `sanitizeScorecard`, `isBlockedIpv4`, `resolveSessionPath`,
`classifyMistakes`, `runValidation` are one independent guard per field or a single `||`
chain, and a 120-line test body; their scores come from ternaries, `&&` chains and line
count, not from nesting a reader has to untangle. `unused_files` is the same entry-point
cascade as knip's `files`: `docs/architecture-diagram-alternatives/rasterize.ts` is
documented as `bun rasterize.ts` in its README, and `scripts/fault-inject.ts` is invoked
by the justfile.

**knip — its type analysis is real, its file analysis is not.** 50 of its 84 merged
findings are `web/` files called unused because no `knip.json` declares the `web` workspace
or the entry points.

Re-measured after the sampler fix (120-finding cap, families sampled separately):

| family     | frame | sampled | verified | verdict                                                                                                                                                                                                                                                          |
| ---------- | ----- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`    | 17    | 5       | **5**    | unused public surface: `AgentBudget`, `PendingRequestFailureSink`, `VersionTrends` have no reference anywhere; `ScreenedField` and `Language` are exported but used only inside their own module                                                                 |
| `exports`  | 3     | 3       | **0**    | all three are entry-point cascades — `connectPeer` and `fileLock` are used by `src/peer/peer-main.ts`, which knip itself reports as an unused file because it is a spawned bin, not an import; `turnKey` is used by `web/lib/timeline.ts`, which knip cannot see |
| `files`    | 59    | 5       | 0        | entry points and `web/` again                                                                                                                                                                                                                                    |
| `binaries` | 2     | 2       | 0        | `herdr` is a real global binary, not a dependency                                                                                                                                                                                                                |

Verdict: keep knip for `types` — that class found five real cases of unnecessary public
surface — and treat `files`/`exports` as noise until `knip.json` declares the `web`
workspace and the bin entry points.

**oxlint — the coverage argument, not the count.** 11 findings, 8 sampled, 7 verified, 1
duplicate. Its value is that it is the only executed analyzer that reports in `scripts/`
(3 findings) and scans `web/` at all (51 files, 0 findings). At 62 ms it is the cheapest
signal in the stack.

**jscpd — 91% precision, no value.** 21 of 23 verified, and every one is a clone inside a
test file or between test files. Of 376 clones: 246 in `test/`, 79 YAML
(`mypi-tasks/*/session.yaml` boilerplate), 7 `markup` (base64 inside generated SVG), 3
JSON, 2 markdown, 1 CSS, 4 in `src/`. This is the clearest example of why precision and
actionability are separate columns: the clones are real, and nobody should fix them.

**aislop — 81% overall, and the split is the opposite of what the first pass suggested.**
Re-measured on all 26 sampled aislop findings:

| family                               | sampled | verified | FP    | duplicate | class                                    |
| ------------------------------------ | ------- | -------- | ----- | --------- | ---------------------------------------- |
| `ai-slop/double-type-assertion`      | 1       | 1        | 0     | 0         | unique                                   |
| `ai-slop/unused-import`              | 1       | 1        | 0     | 0         | unique (oxlint reports the sibling rule) |
| `ai-slop/narrative-comment`          | 2       | 0        | 2     | 0         | drop — flagged concise JSDoc             |
| `ai-slop/duplicate-type-declaration` | 1       | 0        | 1     | 0         | drop — the `web` mirror is documented    |
| `security/vulnerable-dependency`     | 2       | 2        | 0     | 0         | unique, lead only                        |
| `security/innerhtml`                 | 1       | 0        | 1     | 0         | known FP — `html: false`                 |
| `ruff/*` (4 rule ids)                | 6       | 6        | 0     | 0         | only Python coverage installed           |
| `complexity/function-too-long`       | 4       | 4        | 0     | 0         | measurement, not a verdict               |
| `complexity/file-too-large`          | 1       | 1        | 0     | 0         | measurement                              |
| `code-quality/duplicate-block`       | 2       | 2        | 0     | 0         | measurement, same axis as jscpd          |
| `python-formatting`                  | 2       | 2        | 0     | 0         | formatter, not audit signal              |
| `eslint/no-unused-vars`              | 3       | 2        | 0     | 1         | duplicate of `ai-slop/unused-import`     |
| `import/no-duplicates`               | 1       | 1        | 0     | 0         | oxlint covers it                         |
| **total**                            | **26**  | **21**   | **4** | **1**     |                                          |

The first pass read this tool as "two good engines, three redundant ones". The rate per
engine says something different: `ai-slop` is the _weakest_ engine (2 of 5 — its two
unique rules hold, its comment and duplicate-type rules do not), while the engines that
were disabled for redundancy carry the highest precision (`ruff` 6/6, `complexity` 5/5,
`duplicate-block` 2/2, `python-formatting` 2/2). That precision is largely tautological:
"this function is 88 lines" and "this import is unsorted" are measurements, and a
measurement is verified by definition. Redundancy, not accuracy, is still why they stay
out of the report — with one exception worth stating: `ruff` is the only Python coverage
in the installed set, and the Python surface here is two documentation scripts.

What is left after the re-measure: keep `double-type-assertion` and `unused-import` from
`ai-slop`, drop `narrative-comment` and `duplicate-type-declaration`, and keep `security`
as leads.

## Density

Denominator: 12,473 production TS lines (`src` 8,304 + `shared` 187 + `web` 3,982).

| category           | est. verified | per 1,000 lines |
| ------------------ | ------------- | --------------- |
| duplication        | 344           | 27.6            |
| lint style         | 86            | 6.9             |
| lint correctness   | 24            | 1.9             |
| unused / dead code | 19            | 1.5             |
| ai-pattern         | 8             | 0.7             |
| complexity         | 0             | 0.0             |
| dead code inline   | 2             | 0.2             |
| **total**          | **484**       | **38.8**        |

Two thirds of the estimated verified population is duplication, and the duplication is
almost entirely test boilerplate. Corrected for actionability, the defensible density is
the non-duplication total: **≈11.2 per 1,000 lines**.

One row is mislabelled by attribution, not by measurement. Until 2026-10-27 the
normalizer filed aislop's whole `code-quality` engine under `unused_file_export_dep`, so
13 of the 19 findings in **unused / dead code** are that engine's
`function-too-long`/`file-too-large`/`duplicate-block` counts, and `complexity 0.0` is an
artefact. The mapping is fixed (`normalize.ts` now decides by rule: `complexity/*` →
`complexity`, `duplicate-block` → `duplication`) but the numbers above come from the
pre-fix collection and are left as measured. Re-collect to move those 13 into a complexity
row; no decision below depends on which row they sit in. The re-measure puts the two tools'
complexity output at opposite ends — fallow `crap`+`cognitive` 0 of 8, aislop
`complexity/*` 5 of 5 by measurement — which is the more useful statement than either row.

## Decisions

1. **Keep `tsc --noEmit`, `oxlint`, `biome` as gates.** Note the coverage split: `web/`
   is a separate project with its own `web/tsconfig.json` and its own `typecheck` script,
   so the root command never sees it. Web is not untypechecked — its own command passes —
   but the audit never ran it, so `tsc clean` here covers `src`/`test`/`shared`/`scripts`
   only. Run both, or add `web` to the root program. Keep `biome` for formatting and
   import assist rather than as an audit source.
2. **Keep `fallow dead-code`; from `health`, keep only `cognitive_crap`.** Drop the
   `crap` (0/5), `cognitive` (0/3) and `unused_files` (0/3) families. Those three were the
   entire false-positive population of the tool; `cognitive_crap` verified 3 of 3 and
   `both`/`all` are mixed.
3. **Keep `aislop` limited to `ai-slop` and `security`, and within `ai-slop` to two rules.**
   That removes 29 of its 46 findings. Among the kept engines, `double-type-assertion`
   (1/1) and `unused-import` (1/1) hold while `narrative-comment` (0/2) and
   `duplicate-type-declaration` (0/1) do not, so the keep list is rule-level, not
   engine-level. Treat its `security` output as leads: `vulnerable-dependency` verified
   2/2 on the lockfile version, and `innerhtml` on `web/views/plan-findings.ts:22` is a
   false positive because `web/lib/markdown.ts` uses `new MarkdownIt({ html: false })`.
   The disabled engines are accurate but redundant; `ruff` is the exception, since nothing
   else in the installed set lints Python, and the Python surface is two doc scripts.
4. **Keep `knip` for `types`; discard `files`/`exports` until it is configured.** A
   `knip.json` declaring the `web` workspace and the bin entry points (`src/pi/launch.ts`,
   `src/peer/peer-main.ts`, scripts) is required before its file/export families say
   anything.
5. **Drop `jscpd`.** 43 MB per platform for boilerplate clones.
6. **Record, do not score:** `dependency-cruiser` (blocked — no ruleset; `--no-config`
   yields `node_modules` noise), `dmmulroy/anti-slop` (unsupported — no package, vendored
   plugin pinned to `oxlint 1.78.0`), `typescript-eslint` (deferred — `oxlint --type-check`
   covers the axis).

## Setup cost and maintenance risk

- Provisioning all seven analyzers: one `bun install --frozen-lockfile --ignore-scripts`
  into a prefix outside the repo, 188–191 packages, 5 s cold, 324 MB installed. `aislop`
  alone accounts for 179 packages and 187 MB because it bundles biome, knip, oxlint, and
  TypeScript.
- `fallow` is the one analyzer not pinned in the repo: the machine runs 3.31.0 while npm
  publishes 3.36.0, so its numbers drift unless it is pinned with the rest.
- `jscpd` ships a 43 MB per-platform Rust binary; `oxlint`, `biome`, and `jscpd` all carry
  platform-specific native binaries, which is why pinning means hashing the executable,
  not the `.bin` shim.
- Three analyzers write into the tree they analyze: `fallow` (`.fallow/cache.bin`,
  `.fallow/graph-cache.bin`), `aislop` (`.ruff_cache/`), `jscpd` (`./report/` without
  `-o`). Declaring them is what keeps a "read-only" claim honest.

## Not measured

- **Recall.** No labelled defect set exists; 643 findings are what these tools noticed.
- **Knip's `exports` family after configuration.** The three sampled false positives are
  explained by missing entry points; whether the family becomes useful once they are
  declared is untested.

- **Advisory applicability.** `zod` 4.6.5 is a direct dependency; `undici` 8.10.2 arrives
  inside `@earendil-works/pi-coding-agent` (`bun.lock:432`, `bun.lock:450`). Both versions
  are confirmed against the lockfile; neither advisory was checked against an advisory
  database. The adjudicators' and recorder's GHSA ids and "fixed in" versions are not in
  the frozen reporter output and must not be cited as evidence.

- **A population estimate from the second pass.** Its strata frames do not sum to the
  tool populations (fallow 27 against 43), so only the within-sample rates are usable.

- **Whether fallow `cognitive_crap` (3/3) generalizes.** Three findings is the smallest
  complete family in either table, and the rule overlaps badly with the `crap`/`cognitive`
  families dropped next to it.
- **The model-review delta.** `audit.json.instruction_reviews` is empty; the unguided and
  Ponytail-guided passes exist only as prose in `run-details/findings.md`. The qualitative
  read — Ponytail's lens added duplication/dead-code signal and changed nothing on
  correctness severity — is unquantified.
- **Provenance.** `run.commit` is `9f9ca93`, which predates the still-untracked audit
  tooling.

## What would change these verdicts

In order of value: a `knip.json` with the `web` workspace and entry points (the only
item blocking a final knip verdict); an advisory-database check for the two dependency
leads; and structural recording of the model passes so the Ponytail comparison can be
scored instead of narrated.

## Sampler correction (follow-up #108)

The first run's sampler had two defects, both fixed and unit-tested:
- **Strata keyed by category.** All four knip families collapsed into one stratum of 84
  findings, which drew 9 samples and none from `exports`/`types`. Strata are now keyed by
  `(tool, rule family)` — `lint/style` vs `lint/suspicious` for biome, `ai-slop` vs
  `security` for aislop, and each knip issue key on its own.
- **No visibility guarantee.** With 26 rule-family strata, a 5-per-family floor exceeded
  the 80 cap and the largest family (`jscpd/exact`, 376 findings) received zero samples.
  Allocation is now: one per family for visibility, then floors (smallest families first),
  then top-up toward 10% of frame (largest first). The cap is a flag
  (`--sample-cap`); the re-measure used 120 and left no family unsampled.

A third defect surfaced only because the above made reproducibility testable: finding ids
embedded the analyzer's array index, and oxlint is multi-threaded, so diagnostic order
changed between runs and the same seed produced different samples. Ids are now derived
from content (`tool:rule:path:line:digest(message)`), and two runs on fresh copies of the
same commit now produce byte-identical samples.
