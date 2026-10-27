# Analyzer evaluation (pilot evidence)

Deliverable for issue #106. Guidance layer: [`tool-selection.md`](./tool-selection.md).
Evidence layer: this file. Everything here is derived from the completed pilot run —
task `11-antislop-audit`, HEAD `9f9ca93`, 2026-10-27, `$1.98`, no fixes applied.
Artifacts: `mypi-tasks/11-antislop-audit/run-details/audit/`.

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

## Per tool

| tool   | raw | merged | n   | verified | FP  | est. verified | actionability                                          | wall     | verdict                         |
| ------ | --- | ------ | --- | -------- | --- | ------------- | ------------------------------------------------------ | -------- | ------------------------------- |
| biome  | 87  | 87     | 12  | 12       | 0   | 87            | low — test-file style plus one format error on a doc   | 322 ms   | keep as gate                    |
| fallow | 43  | 43     | 11  | 3        | 8   | 7             | medium — dead-code half only                           | 401 ms   | keep `dead-code`, drop `health` |
| tsc    | 0   | 0      | —   | —        | —   | —             | baseline only                                          | 3,031 ms | keep as gate                    |
| knip   | 98  | 84     | 15  | 5        | 0   | 17            | `types` only — 5/5 verified unnecessary public surface | 464 ms   | keep `types`, configure entries |
| oxlint | 11  | 11     | 8   | 7        | 0   | 10            | medium — only tool reporting in `scripts/`             | 62 ms    | keep as gate                    |
| jscpd  | 376 | 376    | 23  | 21       | 2   | 343           | **low** — verified clones are boilerplate              | 94 ms    | drop                            |
| aislop | 46  | 42     | 17  | 15       | 2   | 36            | 3`ai-slop` + 1 `security`, rest duplicates             | 1,282 ms | keep 2 of 5 engines             |

`est. verified` for aislop counts its Python verdicts too; the relevant subset is 4. See
the aislop section.

## Where the numbers mislead, tool by tool

**biome — 100% precision, little value.** All 12 sampled verdicts were in `test/`: 9
`noNonNullAssertion`, 2 `noExplicitAny`, 1 `noIdenticalTestTitle`. Its 87th finding is a
format diff on `docs/antislop/workflow.md`. Nothing in `src/`, nothing in `web/` (excluded
by config). It is a formatter and a new-code gate; it is not an audit instrument here.

**fallow — two engines, opposite quality.** `dead-code` produced the useful signal (2 of 5
sampled unused-export verdicts held). `health` produced 5 of its 8 false positives: four
`crap` and one `cognitive` score on short, clear functions, plus three `unused_files` hits
on real entry-point scripts. Run the first, not the second.

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

**aislop — five engines, two of them interesting.** `ai-slop` (14 findings) and `security`
(3) carry classes no other installed tool produces: `double-type-assertion` (4),
`duplicate-type-declaration` (2), `narrative-comment` (4, of which 2 sampled were false
positives), `unused-import` (4), plus dependency advisories and one injection sink. The
other three engines reproduce work already paid for: `lint` (12) is 5 rule ids oxlint ran
and 7 `ruff/*` findings on `docs/*.py`; `format` (2) is Python formatting; `code-quality`
(15) is `file-too-large`/`function-too-long`/`duplicate-block`, the same axis as
`fallow health` and jscpd.

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

## Decisions

1. **Keep `tsc --noEmit`, `oxlint`, `biome` as gates.** Note the coverage split: `web/`
   is a separate project with its own `web/tsconfig.json` and its own `typecheck` script,
   so the root command never sees it. Web is not untypechecked — its own command passes —
   but the audit never ran it, so `tsc clean` here covers `src`/`test`/`shared`/`scripts`
   only. Run both, or add `web` to the root program. Keep `biome` for formatting and
   import assist rather than as an audit source.
2. **Keep `fallow dead-code`; do not run `fallow health` into the report.**
3. **Keep `aislop` limited to `ai-slop` and `security`.** That removes 29 of its 46
   findings. Treat its `security` output as leads: one sampled verdict was verified, and a
   second — `innerhtml` on `web/views/plan-findings.ts:22` — is a false positive because
   `web/lib/markdown.ts` uses `new MarkdownIt({ html: false })`.
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

- **Advisory applicability.** `zod` 4.6.5 is a direct dependency; `undici` arrives inside
  `@earendil-works/pi-coding-agent`. Neither advisory was checked against an advisory
  database.
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
