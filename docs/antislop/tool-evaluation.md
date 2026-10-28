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

- Provisioning all ten analyzers: two installers into one prefix outside the repo. bun
  (`bun install --frozen-lockfile --ignore-scripts`) covers the seven npm tools — 188–191
  packages, 5 s cold, 324 MB. `aislop` alone accounts for 179 packages and 187 MB because it
  bundles biome, knip, oxlint, and TypeScript. uv (`uv venv` + `uv pip install -r
  requirements.txt`) covers `mypy` 2.4.0, `bandit` 1.9.4 and `ruff` 0.17.3 into
  `<prefix>/python` — 100 MB, wheels only, no build step. Total prefix ~491 MB.
- **The three Python tools are not npm packages.** The npm names `mypy`, `bandit` and `ruff`
  are unrelated projects (an ES6 coroutine library, a CloudFormation helper, and a two-file
  stub with a `"1"` description); none has a `bin` entry, so pinning them through
  `package.json` cannot work. They are pinned in `requirements.txt` and hashed from
  `<prefix>/python/bin` by the same identity check that covers the npm binaries — the
  manifest's `bin` field carries the subdirectory, so `--verify` covers all ten.
- `fallow` is the one analyzer not pinned in the repo: the machine runs 3.31.0 while npm
  publishes 3.36.0, so its numbers drift unless it is pinned with the rest.
- `jscpd` ships a 43 MB per-platform Rust binary; `oxlint`, `biome`, and `jscpd` all carry
  platform-specific native binaries, which is why pinning means hashing the executable,
  not the `.bin` shim. `ruff` is a 22 MB Mach-O binary, hashed directly.
- Three analyzers write into the tree they analyze: `fallow` (`.fallow/cache.bin`,
  `.fallow/graph-cache.bin`), `aislop` (`.ruff_cache/`), `jscpd` (`./report/` without
  `-o`). Declaring them is what keeps a "read-only" claim honest. Two more write by default
  and are switched off in their invocations: `ruff check` creates `.ruff_cache/` unless
  given `--no-cache`, and `mypy` creates `.mypy_cache/` unless given `--cache-dir` (it still
  writes the cache under `--no-incremental`, so the redirect is the only fix).

## Not measured

- **Coverage of real defects — measured, narrowly.** Ten commits drawn with a recorded seed
  from the 44 in this repo whose subject starts with `fix` and that touch code
  (`mypi-tasks/14-recall-coverage/`). **Two of the ten fall inside any enabled rule family's
  field of view**: `biome assist/source/organizeImports` for unsorted imports, `fallow
  unused_exports` for dead exports (knip's `exports` family would see the same defect). The
  other eight are behavioural — async observation ordering, an invariant across time,
  agreement between two artifacts, a classification that contradicts the effect — and no rule
  id in the observed vocabulary encodes any of them. All ten citations were checked against
  the patch hunks; every rule id was checked against the observed inventory.
  **What this is not:** a recall rate. The sample is ten of forty-four, a rule that can see a
  defect may still not fire, and the subject line is not evidence — the diff is. Per-tool
  field of view, denominator always ten: biome 1, fallow 1, knip 1 (same defect as fallow's),
  aislop 0, oxlint 0, tsc 0, jscpd 0. One concrete gap the readers found: biome 2.x ships
  `noFloatingPromises` in nursery, disabled by default; enabled, it would have seen the
  deferred-rejection fix, so the vocabulary measured is the _enabled_ vocabulary.

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


## n=2: finance-hub (task `13-antislop-audit`, 2026-10-27)

Second repo, deliberately a different shape: Next.js app on **npm** (36,475 TS/TSX LOC
repo-wide, 237 source files in `src/` and `tests/`) plus a real Python subsystem,
`telegram-forwarder/` (21 files, 3,601 LOC). `.venv` (915 `.py`) and `.next` (514 JS/TS)
sit in the tree. Artifacts: `mypi-tasks/13-antislop-audit/run-details/`.

| stage                        | result                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| collection                   | 2,019 merged findings; **745 out of scope** (`data/`, `graphify-out/`, agent config dirs, lockfile), 1,274 in scope |
| in scope by tool             | biome 702, aislop 218, jscpd 177, fallow 133, oxlint 31, tsc 12, knip 1                                             |
| sample                       | 120 rows by (tool, rule family); 43 rule_id families, **13 at n=5, 30 anecdote**                                    |
| two peers, identical prompts | disagree on **75 of 120 rows**, 126 fields: validity 18, actionability 64, consequence 44                           |
| blinded control              | 20 rows (one per family), same model, tool and rule names removed: **13/20 rows flipped**, 22 fields, 3 validity    |

**The three axes are not equally reproducible.** Validity agreed on 102 of 120 rows, and on
57 of those 102 the same two peers still differed on actionability or consequence. Validity
is a reading of the cited code; the other two are judgements about consequences, and they
move. Treat a single adjudicator's actionability and consequence as one opinion, not a
measurement.

**Blinding moved a lot.** Thirteen of twenty rows changed verdict when the tool and rule
names were removed, three of them on validity. Because the blinded subset is one row per
family, no per-family flip rate is computable — so the unblinded per-family numbers in both
runs are **descriptive counts of a reconciled pass, not a precision or stability measure**.
What the pilot recorded as a 20-of-49 split along rule families was, on this evidence,
substantially the brand rather than the code.

What the families said:
- `fallow unused_files`: **4/4 absent** — the same entry-point mechanism the pilot measured
  at 3/3 false positive. Confirmed noise, on a repo with a different entry-point story.
- `fallow crap`: **5/5 present, 5/5 actionability none, 5/5 consequence low**. The pilot
  called this false positive. It is not wrong; it is worthless. That relabelling is the
  payoff of splitting validity from actionability — one tool, two different failure modes,
  previously one label.
- `knip types`: 1/1 present; material to one adjudicator, marginal to the other. The
  pilot's 5/5 stands.
- `biome`: 702 in scope, dominated by format (135), `noAssignInExpressions` (80),
  `noNonNullAssertion` (57) and import ordering (52). Adjudicated present with actionability
  none. A formatter and an import assist, not an audit instrument — the pilot's conclusion
  at three times the scale.
- `tsc TS2345` (12): all 12 are in `tests/`, `Request` vs `NextRequest` and one
  `OrdersResponse` fixture shape. Both adjudicators called them present; they split on
  weight — marginal/low versus material/medium — which is the axis disagreement described
  above, on a family where validity was never in doubt.
- `jscpd`: 177 in scope, still boilerplate. Precise and worthless, as before.
- `aislop`: its `ruff` engine produced **38 in-scope findings across 14 Python files**
  (`I001` 14, `BLE001` 12, `F401` 4, `UP017` 3, `F541` 3, `S110` 1, `UP035` 1), so the
  pilot's "only Python coverage, two doc scripts" framing does not transfer. The 5 sampled
  rows (4 `BLE001`, 1 `F541`) were all present and marginal: real, small, and the only
  Python signal any installed tool produces. The rules in play are ruff's defaults, since
  the repo has no `ruff.toml`.
- `biome parse`: of 268 parse findings, only 5 survive the scope filter and all five are
  the same `src/app/globals.css` failure ("Tailwind-specific syntax is disabled"). One config
  gap counted five times; the other 263 were inside `data/`.

Operational defects this run exposed, both now fixed in the harness:
- **Scope must be declared.** jscpd scanned `graphify-out/`, `data/` and agent dirs and
  produced 612 of its 774 findings outside app source; biome reported 720 inside trees it cannot be told to
  skip from the command line. `collect.ts --ignore <globs>` now declares scope, marks
  findings a tool reported anyway as `out_of_scope`, and keeps them out of the sample.
- **A killed analyzer was recorded as clean.** biome exited 137 (SIGKILL) after 224 s and
  `audit.json` said `status: clean, findings: 0`. The exit code is now compared against
  `expected_nonzero_exit`, and a signal death is named.

Not measured in this run: recall (see above); `typescript-eslint` (#115 — the re-test the
task asked for was not executed, recorded as an explicit exclusion in the task README);
whether biome's Tailwind parse failure is config-fixable; advisory applicability, again.
Transport: both peers' fenced JSON arrays truncated in transit (55 and 100 of 120 rows
survived), and were reassembled from each peer's own line table with zero mismatches on the
155 rows present in both. Future runs batch the packet.

## n=3: narrative-nexus (task `16-antislop-audit-n3`, 2026-10-28)

Third repo, and the first Python-majority one: narrative-nexus at `07d9f1b` — 119 `.py` files,
15,743 LOC Python against 8,610 LOC TS/TSX plus 3 JS files. `data/` (binary `.db` + JSON dumps,
no source) declared out of scope. Artifacts:
`mypi-tasks/16-antislop-audit-n3/run-details/` in narrative-nexus.

| stage          | result                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| collection     | 771 in scope (775 merged, 807 raw); 4 biome/format findings in `data/` marked out of scope                 |
| tools measured | aislop 522, biome 127, jscpd 66, fallow 52, oxlint 7, knip 1; tsc failure (solution tsconfig)              |
| sample         | 103 rows, 21 cohorts, `pickSample` once per cohort (seed 20261028, cap 5); oxlint 7 + knip 1 full-frame    |
| readers        | same 103 rows to both (task-15's disjoint-halves error not repeated), four work orders of 25/26/26/26 rows |
| agreement      | 45/103 agree on all three axes; validity Δ8, actionability Δ22, consequence Δ47                            |

**ruff earns the Python slot, rule by rule.** All 40 sampled ruff rows are factually valid —
38 `present`, 2 correctly `absent` (the `newspaper4k` rows: aislop flags `from newspaper import …`
as hallucinated while `requirements.txt:5` pins `newspaper4k`, whose import name is `newspaper`) —
zero false positives on the sample. But the rules split:

| rule          | verdict                                                                                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F401          | keep — 5/5 dead imports, marginal/low, direct cleanup value                                                                                                                                                                                           |
| UP045 / UP017 | keep — 10/10 mechanical PEP-604 / `datetime.UTC` modernization on a Python 3.12 tree                                                                                                                                                                  |
| BLE001        | keep at warning tier — 5/5 genuine blind excepts, but 4/5 deliberate in probe scripts; the one production hit (`pipeline/runner_scheduler.py:39`, a daily-pipeline handler that prints and drops the traceback) is the highest-consequence Python row |
| EXE001        | keep at low priority — 5/5 true (shebang with no `+x`, all mode 644) and cosmetic                                                                                                                                                                     |
| I001 / F541   | autofix tier — 10/10 true, pure import-order / f-string-prefix noise, never a review signal                                                                                                                                                           |
| B008          | suppress — the construct exists at all 5 lines, but the rule's remedy breaks FastAPI dependency injection at every one; suppress for route modules                                                                                                    |

**The non-ruff cohorts.** `hardcoded-url` 5/5 present but 1/5 material
(`app/investigate_endpoint.py:44` hardcodes `base_url` and a pinned model while the sibling embed
path reads `config/providers.json`). `unused-import` 5/5 marginal/low. `swallowed-exception` 5/5
present, 1–2 material / 2 medium. `hallucinated-import` 3/5 present, 2/5 absent. `range-len-loop`
and `chained-dict-get` present but mostly `none`. `print-debug` present, 2–4 marginal.
`security/vulnerable-dependency` 5/5 present, but the advisory severity text is not in the tree, so
`material` cannot be established. `fallow unused_exports` 5/5 marginal/low (the `toggle.tsx:45`
export has no reachable consumer, but the real cleanup is deleting two dead ui files). `jscpd` 5/5
present and still boilerplate. `biome organizeImports` 5/5 present, `none` — formatter, not auditor.
`oxlint` 7/7 (full frame) is the only census; `knip/types` 1/1 is an anecdote with no rate.

**Validity held; the other two axes did not.** All 8 validity disagreements settled against the
code (5 EXE001 rows by a `stat` mode check — line 1 is a shebang, the 644 file mode is the fact;
the other three by reading the cited line). The 22 actionability and 47 consequence splits are the
same opinion-variance n=2 measured, concentrated in `none` vs `low` on formatting and import-order
rows. No blind control was run this pass — n=2 already showed blinding flips 13/20 — so these
per-family numbers are descriptive counts of a reconciled pass, not precision.

**Coverage caveat.** Python is covered only by ruff running inside aislop. No mypy, no pylint, no
bandit was run, so a Python-majority repo was measured through one engine. 14 excluded ruff cohorts
(F841, FURB162, S110, C401, F821, PERF102, SIM115, SIM905, UP041, S112, PLW1510, F811, TRY004,
RUF059) carry no adjudication. `tsc` is recorded clean from the collect step's run of `tsc -b` and
`tsc --noEmit -p tsconfig.app.json` (both exit 0), not re-measured, since the run checkout has no
`node_modules`. One scanned commit, one seed: nothing about durability across commits.

**Collector defect, reported not fixed here:** the five `security/vulnerable-dependency` finding
ids cite `package.json:0`, a line that cannot exist (package.json is 52 lines; the manifest-level
advisory is normalized to line 0). Both readers resolved them onto real lockfile lines, but the id
normalization is a fixture defect for the next run to fix.

## Where the n=3 ruff numbers actually came from (#117)

The n=3 run measured ruff only through aislop's `lint` engine, and aislop does not bundle ruff:
`resolveToolBinary("ruff")` tries the project venv, then PATH, then a bundled `tools/bin/ruff`
that the package does not ship. Measured on the same commit with the same aislop 0.18.1:

| aislop's PATH                         | total findings | `ruff/*` |
| ------------------------------------- | -------------- | -------- |
| includes `~/.local/bin` (ruff 0.17.0) | 526            | 287      |
| `~/.local/bin` removed                | 168            | **0**    |

So every ruff verdict in the n=3 report describes the ambient `ruff 0.17.0` on this machine — not
a hashed toolchain binary. The _verdicts_ stand (the rules are ruff's own and were adjudicated
against the code), but the provenance was unpinned, which is the attribution gap #117 exists to
close. The toolchain now pins `ruff 0.17.3` from PyPI and puts `<prefix>/python/bin` ahead of the
inherited PATH in aislop's own environment, so the two names measure one binary.

**Standalone ruff also sees more.** Same commit, single collection with all ten tools: ruff
0.17.3 reports 429 findings across 35 files to aislop's 287, the difference concentrated in I001
(137 vs 74), F401 (65 vs 35), F841 (25 vs 9) and EXE001 (32 vs 30). The duplication is real and
the collector now collapses it: 716 raw ruff-condition findings (429 + 287) merge to 424 rows, of
which 366 name both tools. The manifest records the relationship in `duplicates_with` rather than
leaving two sources of one finding unnamed.

**bandit reports 739 findings on narrative-nexus, and 677 of them are B101 `assert_used`** in test
files — the rule fires on every `assert` in a pytest suite, so its count says nothing about
production risk. The remaining 62 (B608 SQL string construction 23, B306 `mktemp` 18, B310 urlopen
6, B108 hardcoded tmp dir 5, B311 `random` 3, B404 subprocess import 1) are leads.

**mypy measured 3 diagnostics and then stopped.** `scripts/v1_concurrency_test.py:6` contains a
literal `Path(__file__)....[truncated]` — the file is not valid Python — and mypy has no
continue-past-syntax-error mode, so it exits 2 there having checked almost nothing else
(`--explicit-package-bases` is what gets it that far: without it, a duplicate-module fatal masks
even those three). The tool ran and its output parsed; the number is about the repo, not the tool.

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

## Type-aware axis (task `15-type-aware-adjudication`, finance-hub, 2026-10-28)

The one axis aimed at behaviour rather than shape, run over the same tree as the n=2 audit.

| measurement                                                                      | value                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| findings, pinned eslint 10.13 + `typescript-eslint` `projectService`             | 154 (6 rules, after excluding 34 `eslint-disable` artifacts)             |
| findings, `oxlint --type-aware` (tsgolint 7.0.2005) restricted to the same rules | 155                                                                      |
| agreement on the six shared rules                                                | 4/4, 8/8, 32/32, 21/21, 85 of 86, 4/4                                    |
| distinct findings after dedupe, 8 rules                                          | 149 — 144 seen by both engines, 5 oxlint-only                            |
| what the repo's own eslint config reports type-aware                             | 0 (66 messages, 4 rules, all syntactic)                                  |
| sample                                                                           | 36 rows by rule family, two readers on disjoint halves, three dimensions |
| validity                                                                         | 33 present, 2 duplicate, 1 absent                                        |
| actionability / consequence                                                      | 11 material, 21 marginal, 1 none / 10 medium, 22 low, 1 none, 0 high     |

Only `no-unnecessary-condition` clears the anecdote line: 6 of 8 material, and six of those
share one mechanism — a type that overstates the data (`as string`, `as number`,
`as Record<string, unknown>` over unvalidated API JSON, destructure of an asserted array), so
the `??`/`||` the rule calls dead is the only thing between a missing property and an empty
account key. Everything else is marginal single rows. Two operational facts: oxlint finds
`tsgolint` on PATH only, and an eslint profile must declare every plugin the repo's own
`eslint-disable` directives name or it reports them as findings (28 unused, 6 undefined-rule).

**What it does not establish:** no row is a bug that happened, no type-aware rule caught a
defect the syntactic stack missed in the ten-fix sample, and the two readers never judged the
same row — so this run measures the axis, not inter-reader agreement.
