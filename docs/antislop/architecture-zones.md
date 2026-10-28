# Architecture zones

## What was measured

The committed `.fallowrc.json` carries a `boundaries` block: 5 zones and 2 rules
(`contracts → [contracts]`, `runtime → [contracts, peer, platform]`). Measured at repo root with:
- `$HOME/.audit/antislop/node_modules/.bin/fallow list --format json` → `run-details/measurement-list.json`
- `$HOME/.audit/antislop/node_modules/.bin/fallow dead-code --format json --quiet --boundary-violations` → `run-details/measurement-dead-code.json`
- `$HOME/.audit/antislop/node_modules/.bin/fallow list` → `run-details/measurement-list.txt`

Result: **zero boundary violations**. `measurement-dead-code.json` reports `"total_issues": 0`
and `"boundary_violations": []`. `measurement-dead-code.stderr.txt` is empty — no
`WARN boundary zone '<name>' matched 0 files` line, so every declared zone matched at least
one file.

The committed measurement ran in the real repo with `node_modules` present:
`measurement-dead-code.json` `workspace_diagnostics` contains only `rule-packs-not-configured`
(no `node-modules-missing`), and `measurement-list.json` reports `file_count: 200`,
`workspace_count: 2`. `fallow list` is **not** zone-match evidence either way:
`measurement-list.json` and `list-probe.json` have **no `boundaries` key at all** (absent, not
null), and neither `list` output has a boundaries section.

The zero is a real measurement, not an inert detector, for two recorded reasons:
`positive-control.json` (runtime `allow` narrowed to `["contracts"]`) reports 31 violations
(29 `runtime→platform`, 2 `runtime→peer`), proving the detector fires when a rule is crossed;
`negative-control.stderr.txt` (`negcontrol` → `src/definitely-no-such-dir/**`) emits
`WARN boundary zone 'negcontrol' matched 0 files`, proving the match-failure warning fires on
this tree, so its absence in the committed run is meaningful.

## Semantics

### When an edge is forbidden

An import is a violation when the importing file is classified into a zone `Z`, a rule with
`from: Z` exists, and the imported file's zone is not in that rule's `allow`.
`explain-violation.txt`: "A module imports from a zone that its configured boundary rules do
not allow." Recorded proof: `probe-4.json` + `probe-4.fallowrc.json` (zone `bus` restricted to
`allow:["runtime"]`) yield exactly two findings, `src/bus/message-validator.ts:6` and
`src/bus/router.ts:6`, both `from_zone:"bus"`, `to_zone:"contracts"`,
`effective_severity:"error"`. A `from` zone with **no rule is unconstrained**:
`probe-2.fallowrc.json` declares three zones with no `rules`, and `probe-2.json` reports 0
violations. Type-only imports count by default: `probe-4.json` flags `src/bus/router.ts:6`,
which is `import type { A2AEnvelope } from "../contracts/a2a-schema";`.

### How an allowed edge is declared

Declared as a per-`from` rule in `boundaries.rules`: `{ "from": "<zone>", "allow": ["<zone>", …] }`
(`probe-3.fallowrc.json`, `probe-4.fallowrc.json`). **`allow` is an exhaustive allowlist for
that `from` zone**, not additive to a default: `probe-4` (allow runtime) flags `bus→contracts`
so an unlisted pair is forbidden; `probe-3` (allow contracts) flags nothing so a listed pair is
permitted. Same-zone imports are exempt (`probe-4.json`: intra-`bus` imports are not reported).

### Preset names and meanings

The four preset values and their schema meanings, from `config-schema.json`
`/$defs/BoundaryPreset`:

| preset           | meaning                           |
| ---------------- | --------------------------------- |
| `layered`        | "Layered architecture."           |
| `hexagonal`      | "Hexagonal / ports-and-adapters." |
| `feature-sliced` | "Feature-Sliced Design."          |
| `bulletproof`    | "Bulletproof React."              |

(`schema-names.txt`, a `strings` dump, independently corroborates the four variant names:
`BoundaryPresetlayeredhexagonalfeature … slicedbulletproof`.) What each preset expands to as a
concrete zone/rule list is **not settled**: no recorded probe uses `preset`, `help.txt` never
mentions it, and no probe output contains a preset-produced zone or rule list. Not filled from
outside knowledge.

## Zones

| zone      | patterns                                                                                                                                                                                                                            | existence evidence                                                                                                                                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts | `src/contracts/**`                                                                                                                                                                                                                  | `src/contracts/a2a-schema.ts:1-5` header: "This is the trust boundary the bus validates against (src/bus/message-validator.ts)"; 75 import lines target it (`import-target-counts.txt`)                                                                                            |
| runtime   | `src/runtime/**`                                                                                                                                                                                                                    | `src/runtime/runtime.ts:1-5` header ends "Created and driven by src/pi/extension.ts"                                                                                                                                                                                               |
| pi        | `src/pi/**`                                                                                                                                                                                                                         | `src/pi/extension.ts:1-6` header contains "Loaded by path (nothing imports it)"; `src/pi/launch.ts` is the `bin` target (`package.json` `"bin": {"mypi-run": "./src/pi/launch.ts"}`), which fallow labels an entry point with source `package.json main` (`measurement-list.json`) |
| peer      | `src/peer/**`                                                                                                                                                                                                                       | `src/runtime/runtime.ts:438-439`: `const peerScript = this.peerScript ?? resolve(process.cwd(), "src/peer/peer-main.ts");` / ``return `bun ${peerScript} --config ${cfgPath}`;`` — spawned as a separate process                                                                   |
| platform  | `src/artifacts/**`, `src/budget/**`, `src/bus/**`, `src/control/**`, `src/herdr/**`, `src/jev/**`, `src/locks/**`, `src/logging/**`, `src/scorecard/**`, `src/stack/**`, `src/supervisor/**`, `src/tracing/**`, `src/validation/**` | all 13 dirs exist; `import-target-counts.txt` non-zero for each                                                                                                                                                                                                                    |

Not zoned by design: `shared/`, `test/`, `scripts/` — outside the `src/` module structure, and
no restricted zone imports them.

## Allowed edges

| edge                  | invariant                                                                      | true today | verified line                                                                               |
| --------------------- | ------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------- |
| contracts → contracts | the schema vocabulary may depend only on itself                                | yes        | `src/contracts/a2a-schema.ts:7` — `import { CriterionVerdictSchema } from "./criteria";`    |
| runtime → contracts   | the mechanism speaks the shared vocabulary (permitted direction)               | yes        | `src/runtime/runtime.ts:21` — `import type { A2AEnvelope } from "../contracts/a2a-schema";` |
| runtime → platform    | the mechanism may use any platform module (permitted direction)                | yes        | `src/runtime/runtime.ts:13` — `import { BudgetEnforcer } from "../budget/budget-enforcer";` |
| runtime → peer        | the mechanism starts peers, so may reference the peer implementation           | yes        | `src/runtime/runtime.ts:37` — `import { toPeerConfig } from "../peer/peer-config";`         |
| pi → runtime          | the composition root drives the mechanism; reverse (`runtime→pi`) is forbidden | yes        | `src/pi/extension.ts:40` — `import { Runtime } from "../runtime/runtime";`                  |

Only `contracts → contracts` is an invariant whose breach is a defect. The others are permitted
directions that exist today so the allowlist stays honest. Zero invented invariants.

The precise `contracts` fact: `src/contracts` contains exactly three first-party import lines
plus external `zod` — `a2a-schema.ts:6` `import { z } from "zod";`,
`a2a-schema.ts:7` `import { CriterionVerdictSchema } from "./criteria";`, and `criteria.ts` /
`session-schema.ts` importing `zod` only. So `contracts` has **no first-party import outside its
own zone**; its only non-zone imports are the external `zod`.

## Adjudication

Condensed table:

| id     | pair/zone                                                            | verdict                                                                                                                                      | validity |
| ------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Z1–Z5  | five zones                                                           | real-boundary                                                                                                                                | present  |
| E1     | contracts→contracts                                                  | invariant                                                                                                                                    | present  |
| E2–E4  | runtime→contracts/peer/platform                                      | permitted-direction                                                                                                                          | present  |
| E5     | pi→runtime                                                           | permitted-direction                                                                                                                          | present  |
| PC1    | runtime→platform (29)                                                | absent — over-report caused by a named config decision                                                                                       | absent   |
| PC2    | runtime→peer (2)                                                     | absent — over-report caused by the same config decision                                                                                      | absent   |
| R1–R28 | all rejected intra-platform / composition-root / child-process edges | permitted-direction (correctly left rule-less)                                                                                               | present  |
| R29    | peer→runtime                                                         | absent — not an over-report: no such import exists (grep of `src/peer` for `../runtime` = none; no `peer→runtime` row in `import-edges.txt`) | absent   |
| R30    | contracts inbound-forbidden                                          | absent — not an over-report: not expressible, because rules attach to the importing zone only (`probe-4.json`)                               | absent   |

The two over-report rows and their config decision: `positive-control.fallowrc.json` narrowed
runtime's `allow` from `["contracts","peer","platform"]` to `["contracts"]`, deleting the two
permitted target zones, so all 29 `runtime→platform` and 2 `runtime→peer` imports became
findings. The committed config allows exactly those pairs
(`src/runtime/runtime.ts:13` platform; `src/runtime/runtime.ts:37-38` peer). The two
non-over-report absences (R29, R30) have no config decision behind them.

**Are there real defects?** None. Both committed invariants hold: `contracts` has no first-party
import outside its own zone (only `./criteria`, `src/contracts/a2a-schema.ts:7`; everything else
in the zone is external `zod`), and no `runtime` file imports `pi` (grep of `src/runtime` for
`../pi` = none; the positive control reported no `runtime→pi` rows). There is nothing to fix.

## What this does not establish

- Dependency _direction_ only — not ownership, runtime behaviour, or whether a zone's code
  belongs together.
- Zones `pi`, `peer`, `platform` emit zero signal by construction (no rules attached), so the
  zero result certifies the two declared invariants, not the whole architecture.
- `shared/`, `test/`, `scripts/` are unzoned, so a future `shared/ → src/` inversion is invisible.
- Preset _expansion_, `autoDiscover`, `allowTypeOnly`, empty `allow`, and the fate of a
  restricted zone importing an unzoned file are not settled by the recordings; the committed
  block avoids all of them. (The preset names and schema meanings are settled — only their
  zone/rule expansion is not.)
- Probe-tree limitation, not a measurement limitation: `probe-1.json` … `probe-5.json` carry a
  `node-modules-missing` diagnostic because `/tmp/arch-probe` was a copy without `node_modules`,
  so npm-package classification in the probes is unreliable. The committed measurement was not
  that tree — `measurement-dead-code.json` has no `node-modules-missing` diagnostic and
  `measurement-list.json` reports `file_count: 200`, `workspace_count: 2`.
