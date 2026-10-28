# dependency-cruiser — evaluation for the anti-slop audit

**Verdict.** `dependency-cruiser` is real, well-maintained and widely installed, but its _marginal_
value over this audit's stack is ~zero — and the earlier `blocked` record was a measurement error. It
does ship a rule preset (`configs/recommended.cjs`); what the first run never had was rules. With no
config file it exits 1 by design
(`src/cli/normalize-cli-options.mjs:validateAndGetDefaultRulesFileName`), and with `--no-config` it
validates _nothing_, printing `✔ no dependency violations found` and exiting 0
(`package.json:scripts.test:glob`). The 1,299 modules and 20 "circulars" were graph metadata, not
findings: `--no-config` skips the `doNotFollow: node_modules` filter the shipped preset sets
(`configs/recommended.cjs`). So the old verdict was wrong for the reason it was recorded, and still
right: cycles are already reported three ways (knip `cycles`, oxlint `import/no-cycle`, fallow
`circular-dependency`), orphan files twice (knip `files`, fallow `unused_files`), unresolved imports
by knip `unresolved`. The one category the audit lacks — `architecture` — is a _config-absence_
problem: `.fallowrc.json` here declares no `boundaries` zones, so fallow's boundary engine had nothing
to check either. dc would be a second config-dependent boundary engine, not a first one.

## 1. Is it actually used?

| Signal                                    | Value                                            | Source                                                                            |
| ----------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| npm downloads, last week / 30 days / year | 6,474,894 / 20,827,072 / 105,043,517             | `https://api.npmjs.org/downloads/point/last-{week,month,year}/dependency-cruiser` |
| GitHub stars / forks / open issues        | 7,343 / 306 / 37                                 | `https://api.github.com/repos/sverweij/dependency-cruiser`                        |
| Published versions (all time)             | 591                                              | `https://registry.npmjs.org/dependency-cruiser` → `.time`                         |
| Stable releases, last 12 months           | 24                                               | same, `.time`                                                                     |
| Latest stable / beta                      | 18.7.0 (2026-10-19) / 18.8.0-beta-1 (2026-10-23) | `https://api.github.com/repos/sverweij/dependency-cruiser/releases?per_page=6`    |
| Last push / license                       | 2026-10-26 / MIT                                 | repo API, `pushed_at`, `license.spdx_id`                                          |

**Installed ≠ configured.** GitHub code search returns **1,138** files matching
`filename:.dependency-cruiser.js`
(`https://github.com/search?q=filename%3A.dependency-cruiser.js&type=code`, `total_count`) against
~6.5M weekly installs, which are dominated by CI churn and cache misses. Configured use concentrates
in mid-tier OSS: a 100-file page (`gh search code --filename .dependency-cruiser.js --limit 100`)
resolves to 45 repos, incl. `ag-grid/ag-grid`, `concrete-utopia/utopia`, `liveblocks/liveblocks`,
`instructure/canvas-lms`, `PrairieLearn/PrairieLearn`, `scalableminds/webknossos`,
`MaibornWolff/codecharta`, `Emurgo/yoroi`.

**No marquee default.** 14 famous JS/TS repos checked for `.dependency-cruiser.{js,cjs,mjs,json}` at
root via `raw.githubusercontent.com` HEAD: none has one — `sveltejs/svelte`, `vercel/next.js`,
`microsoft/vscode`, `angular/angular`, `nestjs/nest`, `vuejs/core`, `vitejs/vite`, `nrwl/nx`,
`storybookjs/storybook`, `mermaid-js/mermaid`, `sindresorhus/got`, `vercel/turborepo`,
`remix-run/react-router`, `withastro/astro` (chosen by fame, not random: proves "no marquee default",
not a rate). Do **not** cite `doc/real-world-samples.md` as adoption: those graphs add dc to a
checkout _with the doc's own config_ (the yarn-berry recipe downloads
`berry-dependency-cruiser-config.js` from the dc repo). Demo, not usage.

## 2. What does it emit with no config?

Three distinct states, which the earlier run conflated.

| Invocation                                                               | Behaviour                                                                                                                                                                                                                                                                                                                          | Proof                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `depcruise src`, no config file present                                  | **exit 1**, `Can't open a config file (.dependency-cruiser.(c\|m)js) at the default location`                                                                                                                                                                                                                                      | `src/cli/normalize-cli-options.mjs:validateAndGetDefaultRulesFileName`; search list `.dependency-cruiser.{json,js,cjs,mjs,ts,cts,mts}` in `src/cli/defaults.mjs:RULES_FILE_NAME_SEARCH_ARRAY` |
| `depcruise --no-config src`                                              | **exit 0, zero findings.** `--no-config` is a _hidden_ flag (`bin/dependency-cruiser.mjs`, `.hideHelp(true)`) setting `validate: false`, so no rule set loads (`src/cli/normalize-cli-options.mjs:normalizeValidationOption`) and the analyzer marks every module and dependency `valid: true` (`src/analyze/add-validations.mjs`) | the maintainer's own regression script asserts it: `package.json:scripts.test:glob` expects `✔ no dependency violations found (6 modules, 0 dependencies cruised)` from a `--no-config` run   |
| `depcruise src` with `extends: "dependency-cruiser/configs/recommended"` | 7 rules fire                                                                                                                                                                                                                                                                                                                       | `configs/recommended.cjs`                                                                                                                                                                     |

**No default ruleset, but a shipped preset.** `configs/recommended.cjs` composes seven rules —
`no-orphans`, `no-circular`, `no-deprecated-core`, `no-duplicate-dependency-types`,
`no-non-package-json`, `not-to-deprecated`, `not-to-unresolvable` — plus
`options.doNotFollow: { path: "node_modules", dependencyTypes: [...] }`;
`configs/recommended-strict.cjs` raises all to `error`, `recommended-warn-only.cjs` the inverse. It
ships in the tarball (`package.json:files` includes `configs/**/*.cjs`) and the `extends` spec is
documented (`doc/rules-reference.md:163,206`). Opt-in only: nothing loads it unless asked.

**Rule types** (`doc/rules-reference.md:3-48`): `forbidden`, `allowed` (+`allowedSeverity`, default
`warn`), `required` (mandatory `module` attribute; direct or `reachable`), `extends`, `options`.
**Conditions** (`doc/rules-reference.md`, contents list): `path`, `pathNot`, `orphan`, `reachable`,
`couldNotResolve`, `numberOfDependentsLessThan`, `numberOfDependentsMoreThan`, `circular`, `ancestor`,
`license`/`licenseNot`, `dependencyTypes`/`dependencyTypesNot`, `dynamic`, `moreThanOneDependencyType`,
`exoticallyRequired`, `preCompilationOnly`, `moreUnstable`.

**Evaluable without user declaration: none.** The facts are always computed —
`src/analyze/analyze-modules.mjs` unconditionally runs `deriveCycles`, `deriveOrphans`,
`deriveReachable`, `deriveModuleMetrics` — but a fact becomes a violation only when a user-authored
rule points at it. That gap produced the old record: `-T json` from a `--no-config` run carries
per-module `cycles`/`orphan` metadata with `valid: true` everywhere, so grepping the JSON for `cycles`
sees graph data, not errors. No `exclude` and no `doNotFollow` apply by default
(`doc/options-reference.md:438` documents `exclude` as user-supplied; the _preset_, not the tool,
supplies `doNotFollow`).

## 3. Minimum viable ruleset, and what it costs

`.dependency-cruiser.cjs` at repo 1's root — 15 lines, three invariants: no cycles, no orphans, one
layering direction.

```js
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "no-orphans",
      severity: "warn",
      to: {},
      from: { orphan: true, pathNot: "(^|/)[.][^/]+[.](?:[cm]?[jt]s|json)$|\\.d\\.[cm]?ts$" },
    },
    {
      name: "runtime-not-to-pi",
      severity: "error",
      comment: "src/runtime is the mechanism; src/pi is the composition root that drives it.",
      from: { path: "^src/runtime/" },
      to: { path: "^src/pi/" },
    },
  ],
  options: { doNotFollow: { path: "node_modules" } },
};
```

Each option with its doc: `forbidden` (`doc/rules-reference.md:78`); `name`/`severity` (defaults
normalised in `src/main/rule-set/normalize.mjs`: `unnamed`, `warn`); `circular`
(`doc/rules-reference.md:723`); `orphan` + `pathNot` (`doc/rules-reference.md:485` — the exclusion
regex copies shipped `configs/rules/no-orphans.cjs`, without which every dot-file and
`tsconfig.json`-adjacent module is flagged); `doNotFollow` (`doc/options-reference.md`,
"exclude/doNotFollow").

**Why `.cjs`, not `.js`:** repo 1's `package.json` says `"type": "module"` and
`src/config-utl/extract-depcruise-config/read-config.mjs` `import()`s the config, so a
`module.exports` file named `.dependency-cruiser.js` throws. `.cjs` is in the search array
(`src/cli/defaults.mjs`).

**Cost is not the line count, it is the invariant.**

| Cost item                     | Evidence                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowing a real layering rule  | The rule above is legitimate only because it holds today (**verified**: 0 imports `src/runtime` → `src/pi`, 2 the other way) and is stated in the code's own header (`src/runtime/runtime.ts:1-6`, "Created and driven by src/pi/extension.ts"). Without a written invariant the auditor invents one, which `docs/antislop/workflow.md:34` forbids. |
| Regex-per-rule path wrestling | Every rule is regex over resolved paths; `configs/rules/no-orphans.cjs` spends 26 lines of path regex on one idea.                                                                                                                                                                                                                                  |
| `--init` blowup               | `depcruise --init` emits `src/cli/init-config/config-template.mjs` verbatim: **368 lines** of commented config for 11 rules.                                                                                                                                                                                                                        |
| Multi-project repos           | One tsconfig per run (`doc/options-reference.md:638`). Repo 1's two project files carry no `paths`, so one run over `src test shared scripts web` suffices; repos 2/3 need the tsconfig holding their aliases (§5).                                                                                                                                 |

**Correction to the brief:** repo 1's root `tsconfig.json` is **not** a solution file — it is
`{"compilerOptions": {...}, "include": ["src","test","shared","scripts/antislop"]}`, with no
`files: []`, no `references`, no `paths`. The solution-style file (`"files": []` + `references` to
`tsconfig.app.json`/`tsconfig.node.json`) is **repo 3's**. That inverts the risk: repo 1 has no alias
resolution to get wrong, repo 3 has nothing but.

## 4. Does it detect anything the stack cannot?

Stack per `docs/antislop/tool-selection.md:17-24`: tsc, oxlint, biome, fallow, knip, jscpd, aislop,
ruff, oxlint `--type-aware`. Categories per `scripts/antislop/schema.ts:26-38`, incl.
`dependency_cycle_boundary` and `architecture`.
| dc capability                                  | Covered by                                               | Rule id                                                                                                                                          | Verdict                                                                            |
| ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Cycles (`to.circular`)                         | knip                                                     | `cycles` — "These files (in)directly import each other at runtime", off by default, needs `--cycles` (`https://knip.dev/reference/issue-types`)  | duplicate                                                                          |
| Cycles, at lint time                           | oxlint                                                   | `import/no-cycle`, needs `"plugins": ["import"]` (`https://oxc.rs/docs/guide/usage/linter/rules/import/no-cycle`)                                | duplicate                                                                          |
| Cycles, dead-code run                          | fallow                                                   | `circular-dependency` (`--circular-deps`), plus `re-export-cycle`, `package-cycle` (`~/.pi/agent/skills/fallow/references/issue-types.md:31-33`) | duplicate                                                                          |
| Boundary violations (`from.path`/`to.path`)    | fallow                                                   | `boundary-violation` with `layered`/`hexagonal`/`feature-sliced`/`bulletproof` presets and `autoDiscover` zones (`…/issue-types.md:34`)          | duplicate; fallow needs _less_ config (presets) than dc (hand-written regex pairs) |
| Orphans (`from.orphan`)                        | knip`files`, fallow `unused_files`                       | both already mapped by `scripts/antislop/normalize.ts:117`                                                                                       | duplicate                                                                          |
| Unresolvable imports (`to.couldNotResolve`)    | knip                                                     | `unresolved` (`https://knip.dev/reference/issue-types`)                                                                                          | duplicate                                                                          |
| Dep missing from package.json                  | knip                                                     | `unlisted`                                                                                                                                       | duplicate                                                                          |
| `reachable: false` dead wood from entry points | —                                                        | —                                                                                                                                                | **unique**                                                                         |
| `moreUnstable` (Martin instability)            | —                                                        | —                                                                                                                                                | **unique**                                                                         |
| `license`/`licenseNot` policy                  | —                                                        | — (aislop security ≠ licence policy)                                                                                                             | **unique**                                                                         |
| `no-duplicate-dep-types`                       | —                                                        | —                                                                                                                                                | unique, near-zero yield                                                            |
| Per-edge cycle _path_ (`via`, `viaOnly`)       | — (knip/oxlint report the cycle, not a constrained path) | —                                                                                                                                                | **unique**, narrow                                                                 |

So: **not (a), not (c), only partly (b), and (d) is three low-yield families.** The residue —
`reachable`, `moreUnstable`, licence policy, cycle-path constraints — has no category in the audit
schema, and whether it would fire on these repos is **not verified** (one configured run settles it).

**The `architecture` zero is not a tool gap.** That category is populated by fallow's
`boundary_violations`/`boundary_coverage_violations`/`boundary_call_violations`/`policy_violations`
(`scripts/antislop/normalize.ts:134-137`). Repo 1's `.fallowrc.json` holds only
`"ignorePatterns": ["scripts/bun-s4-probe/**", "web/**"]` — no `boundaries` block, so no zones, so
zero findings by construction. Adding dc does not fix that; it duplicates it at higher cost (regex
pairs vs presets). The fix is one authored zone map in `.fallowrc.json`.

## 5. Does it work on a Python-majority repo (repo 3)?

**It cannot see Python, and it will not tell you so.**

| Question             | Answer                                                                                                                                             | Source                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Supported extensions | `.js .cjs .mjs .jsx .ts .tsx .d.ts .cts .d.cts .mts .d.mts .vue .svelte .coffee .litcoffee .coffee.md .csx .cjsx` (+`.ls` if livescript installed) | `doc/cli.md:806-828` (`--info` sample); table built in `src/extract/transpile/meta.mjs` |
| `.py` present        | no                                                                                                                                                 | same                                                                                    |
| Mixed tree traversal | JS/TS half only                                                                                                                                    | `src/extract/gather-initial-sources.mjs:fileIsScannable`                                |
| Silent or loud       | **silent** — `gatherScannableFilesFromDirectory` returns `[]` for a non-scannable extension: no warning, no counter, no exit-code change           | same                                                                                    |
| Escape hatch         | `options.extraExtensionsToScan: [".py"]`                                                                                                           | `doc/options-reference.md:1633-1649`                                                    |

That hatch is a trap: it adds `.py` to the _scan_, and `src/main/resolve-options/normalize.mjs`
comments that "if extract/transpile/index gets an unknown extension it'll fall back to the javascript
parser" — Python through acorn manufactures import edges that do not exist. **Do not use it.**
(Effect not verified by execution; mechanism documented in those two sources.)

| Repo                | Code dc sees                                                                           | Code blind to dc                                                                            | Consequence                                                                |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1 `multi-agent`     | all TS (72 `src`, 106 `test`, 4 `shared`, 21 `scripts`, 51 `web`; node_modules pruned) | none                                                                                        | usable                                                                     |
| 2 `finance-hub`     | 36,475 TS/TSX LOC in `src/` + `tests/`                                                 | `telegram-forwarder/`: 21 `.py`, 3,601 LOC (936 `.py` if its `.venv` is counted)            | TS majority measurable, Python subsystem not                               |
| 3 `narrative-nexus` | 61 TS/TSX, ~8,610 LOC                                                                  | **121 `.py`, ~15,743 LOC** — `pipeline/` 51, `scripts/` 44, `db/` 19, `app/` 3, `worker/` 1 | 65% of the repo invisible; cycle/boundary claims cover the React half only |

Repo 3's alias situation is the concrete failure mode: root `tsconfig.json` is
`{"files": [], "references": [tsconfig.app.json, tsconfig.node.json]}` while `"@/*": ["./src/*"]`
lives in `tsconfig.app.json` (`include: ["src"]`, `exclude: ["src/__tests__"]`); 11 files under `src/`
import via `@/`. `--ts-config tsconfig.json` resolves none and they surface as `not-to-unresolvable`
noise; `--ts-config tsconfig.app.json` is required. Repo 2's single root tsconfig does hold `paths`
(`@/*`, `@/data/*`; 82 files use them). Documented weakness, not exotic: `#565`, open since
2022-02-03.

## 6. Maintenance and failure modes

**Weight.** 1,048,461 bytes unpacked, 244 files, **18 runtime deps**, 6 bins (registry metadata 18.7.0:
`dist.unpackedSize`, `dist.fileCount`, `dependencies`, `bin`) — incl. `acorn*`×5, `enhanced-resolve`,
`tsconfig-paths-webpack-plugin`, `commander`, `prompts`, `rechoir`, `watskeburt`. Engines
`^22 || ^24 || >=26`, enforced at startup (`src/cli/assert-node-environment-suitable.mjs`).

Read-only settings:
- **Output.** `-f, --output-to` defaults to `-` = stdout (`bin/dependency-cruiser.mjs`;
  `OUTPUT_TO` in `src/cli/defaults.mjs`). Already read-only.
- **Cache.** `node_modules/.cache/dependency-cruiser` with the `metadata` strategy
  (`src/main/options/normalize.mjs:DEFAULT_CACHE_FOLDER/DEFAULT_CACHE_STRATEGY`). Docs call
  caching opt-in (`doc/options-reference.md:1898`), yet the maintainer's own scripts pass
  `--no-cache` on non-caching paths (`package.json`: `test:load`, `depcruise:focus`,
  `depcruise:reaches`), implying it is _on_ unless negated. **Not verified**; settle by
  running once against a clean `node_modules/.cache`.
- **Progress.** Off unless `-p`; writes to stderr. Read-only setting: `--progress none`.
- **Baseline.** Off unless `--baseline`; it writes `.dependency-cruiser-known-violations.json`.
  Do not pass it.

`depcruise --no-config --no-cache --progress none -T json -f - -- src` writes nothing.

| Issue   | State  | Opened     | Problem                                                                                         |
| ------- | ------ | ---------- | ----------------------------------------------------------------------------------------------- |
| `#565`  | open   | 2022-02-03 | Resolve local path aliases in monorepos — the exact repo-3 shape                                |
| `#981`  | open   | 2025-01-09 | Submodule analysis of a huge monorepo with yarn workspaces                                      |
| `#947`  | open   | 2024-07-13 | Fails with `combinedDependencies: true` on a monorepo                                           |
| `#575`  | open   | 2022-03-20 | "Unusal baseDir passed to package reading function" on a monorepo                               |
| `#859`  | closed | 2023-11-02 | "How to use in monorepo project" — question, no fix                                             |
| `#1104` | open   | 2026-10-13 | swc parser: `.mts`/`.cts` skipped without usable typescript; `export type … from` not type-only |

Three of the four open monorepo issues predate v13. None of these repos is a yarn-workspace monorepo,
so `#981`/`#947`/`#575` should not bite; `#565` would, on repo 3, without the right `--ts-config`.

**Packaging caveat (not verified by execution):** `extends: "dependency-cruiser/configs/recommended"`
is documented (`doc/rules-reference.md:206`) and ships in the tarball (`package.json:files`), but the
`exports` map has no `./configs/*` key. It works only because dc resolves `extends` through its own
enhanced-resolve instance, whose `DEFAULT_RESOLVE_OPTIONS.exportsFields` is deliberately `[]`
(`src/main/resolve-options/normalize.mjs`). Not something this audit should depend on.

## Recommendation

**Drop `dependency-cruiser` from the scored analyzer set.** Record it accurately instead of `blocked`:
_"capability real; zero marginal coverage; requires an authored invariant to emit anything."_
1. Every capability it has on these repos is already reported by a stack tool, usually with less
   configuration: knip `cycles`/`files`/`unresolved`/`unlisted`, oxlint `import/no-cycle`, fallow
   `circular-dependency`/`unused_files`/`boundary-violation`.
2. The `architecture` gap is a missing `boundaries` zone map in `.fallowrc.json`, not a missing tool.
   One file fixes it and also lights up fallow's `boundary-coverage` (unzoned files), which dc has no
   equivalent for.
3. On repo 3 it sees 35% of the code and says nothing about the other 65%. Its real cost is an
   invariant nobody has written down; authoring that first, then choosing a tool, is the right order.

**Condition that flips it:** once the `boundaries` zones exist in `.fallowrc.json` and fallow reports
zero `boundary-violation`, if someone can still name a real forbidden edge that fallow's zone model
cannot express, dc's `from.path`/`to.path`/`via` pairs become the fallback. Until then it is a second
opinion on config that does not exist.

**Do not** re-run it with `--no-config` and count what the JSON says: `validate: false` marks every
module `valid: true` (`src/analyze/add-validations.mjs`), so the only "findings" available are
unfiltered `node_modules` graph metadata. That run is why the tool was misjudged the first time.
