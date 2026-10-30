# dmmulroy/anti-slop — 55-row rule-family adjudication

**Verdict.** Do not adopt. The rules are accurate descriptions of the code — validity is high —
but **actionability is zero in the sample and consequence is none or low on every row**. Two
families are a formatter's opinion that `biome` already owns (2,900 of 3,393 findings), and two
more are aimed at ad-hoc type narrowing, which this repo does deliberately inside its boundary
parsers. The row stays "never", but now for a measured reason instead of "no npm package".

Provenance: HEAD `d469211`, 2026-10-30. Plugin `oxlint-plugin-anti-slop@0.1.2` (`/tmp/as-run`,
vendored from `dmmulroy/anti-slop@13909c9`), `@oxlint/plugins@1.90.0`, host `oxlint 1.90.0`.
Command: `oxlint -c /tmp/as-run/oxlint.config.json -f json src shared web test scripts`, all 17
generic rules at `warn`. The Effect rules were not enabled (no Effect in this tree).

The recorded reason for "never" was that no package exists and the plugin pins oxlint 1.78.0
against a 1.90.0 host. The packaging fact still holds; the compatibility fact does not. The plugin
loads and fires under 1.90.0 — measured, not inferred. That is what made this sample necessary.

## Counts, by family and source tree

3,393 findings. The distribution is the first result: three quarters of the output is one spacing
rule, and 44% of all findings are in `test/` and `scripts/`.

| family                                      | total | src | web | test | scripts | shared |
| ------------------------------------------- | ----- | --- | --- | ---- | ------- | ------ |
| `require-readable-spacing`                  | 2,568 | 868 | 354 | 722  | 586     | 38     |
| `require-safety-comment-for-type-assertion` | 332   | 73  | 24  | 170  | 62      | 3      |
| `no-unsafe-dictionary-type`                 | 146   | 33  | 11  | 46   | 47      | 9      |
| `no-unknown-parameters`                     | 116   | 22  | 17  | 67   | 10      | 0      |
| `no-runtime-typeof`                         | 112   | 40  | 35  | 10   | 17      | 10     |
| `no-known-value-widening`                   | 45    | 6   | 5   | 7    | 26      | 1      |
| `no-chained-type-assertions`                | 28    | 4   | 0   | 24   | 0       | 0      |
| `no-conditional-empty-object-spread`        | 27    | 20  | 1   | 4    | 2       | 0      |
| `no-array-filter-map`                       | 9     | 6   | 2   | 1    | 0       | 0      |
| `no-unknown-returns`                        | 5     | 0   | 0   | 5    | 0       | 0      |
| `no-module-mocking`                         | 4     | 0   | 0   | 4    | 0       | 0      |
| `no-object-parameters`                      | 1     | 0   | 0   | 1    | 0       | 0      |

## The sample

Rule-family sampling: findings were hashed by `rule|path|line` (sha256), sorted, and the first
five per family taken, with no cap. 55 rows across all 12 populated families, so 10 families
reach the 5-row floor and two (`no-object-parameters`, `no-module-mocking`) are anecdotes.
Every row was read against its source. Adjudication is **unblinded** — the rule name was visible —
so the counts below are counts, not rates, by this document's own standard.

| family                                      | present | material | marginal | none | what the rows actually are                     |
| ------------------------------------------- | ------- | -------- | -------- | ---- | ---------------------------------------------- |
| `require-readable-spacing`                  | 5/5     | 0        | 0        | 5/5  | blank lines `biome` already formats            |
| `require-safety-comment-for-type-assertion` | 5/5     | 0        | 0        | 5/5  | `as` in test doubles and probe scripts         |
| `no-unsafe-dictionary-type`                 | 5/5     | 0        | 1        | 4/5  | `Record<string, unknown>` for parsed JSON      |
| `no-unknown-parameters`                     | 5/5     | 0        | 0        | 5/5  | `(v: unknown)` boundary parsers                |
| `no-runtime-typeof`                         | 5/5     | 0        | 0        | 5/5  | the same boundary parsers, one level down      |
| `no-known-value-widening`                   | 5/5     | 0        | 0        | 5/5  | intentionally JSON-shaped records              |
| `no-chained-type-assertions`                | 5/5     | 0        | 1        | 4/5  | `as unknown as X` in test doubles; 1 in `src`  |
| `no-conditional-empty-object-spread`        | 5/5     | 0        | 0        | 5/5  | the idiom that omits a key instead of widening |
| `no-array-filter-map`                       | 5/5     | 0        | 2        | 3/5  | two passes over small arrays                   |
| `no-unknown-returns`                        | 5/5     | 0        | 0        | 5/5  | test doubles mirroring pi's signatures         |
| `no-module-mocking`                         | 4/4     | 0        | 1        | 3/4  | `vi.mock("node:http")` in the web-tool test    |
| `no-object-parameters`                      | 1/1     | 0        | 0        | 1/1  | `(m: object)` in a test helper                 |

**0 material out of 55.** Five marginal, all micro: two `filter().map()` passes, one
`as unknown as` in `src/runtime/runtime.ts:279`, `Record<string, unknown>` in
`scripts/antislop/normalize.ts`, and the `vi.mock` of node builtins.

### The family that matters: the two narrowing rules are inverted for this repo

`no-runtime-typeof` (112) and `no-unknown-parameters` (116) both say the same thing: do not narrow
with `typeof`, parse at the I/O boundary instead. Every sampled row in both families _is_ the I/O
boundary:
- `src/scorecard/collector.ts:22,27` — `isRecord` and `strOrNull`, the helpers that sanitize an
  untrusted scorecard before it becomes a `RunScorecard`.
- `web/lib/reader.ts:34` — the `DirEntry` predicate over `fs.readdir` output.
- `src/supervisor/finalization.ts:280` — the `path` guard on a tool-call argument.
- `web/lib/spans.ts:27`, `scripts/antislop/normalize.ts:453` — the same pattern, twice more.

The rule's remedy for these findings is the code that is already there. What remains is the
`test/` and `scripts/` share (67 and 17 of `no-unknown-parameters`), where a test double
deliberately takes `unknown`.

## Overlap with what is already enabled

Measured at the same HEAD, same tree:

| stack present   | findings | families                                                                                       |
| --------------- | -------- | ---------------------------------------------------------------------------------------------- |
| plain `oxlint`  | 15       | 4 families, none shared with anti-slop                                                         |
| `biome`         | 87       | `noNonNullAssertion` 84, `noExplicitAny` 2, `noIdenticalTestTitle` 1                           |
| `aislop` 0.18.1 | 49       | per-engine counts only in its JSON: format 2, lint 12, code-quality 16, ai-slop 15, security 4 |

No rule id is shared with anti-slop. The one real class overlap is
`no-chained-type-assertions` (28, of which 4 in `src`) against aislop's
`ai-slop/double-type-assertion`: a chained `as unknown as X` _is_ a double assertion. aislop's
reporter exposes per-engine counts but not per-finding locations, so this overlap is argued from
rule semantics and the chained-assertion sample, not from a location join.

`require-readable-spacing` is not a lint rule in any meaningful sense: it is a blank-line style
that `biome`'s formatter owns, and the repo already runs `biome check` as a gate. 2,568 findings
that a formatter would either fix or contradict.

## What would have to be true to adopt any of it

A repo where the top 2,900 findings cannot occur — i.e. one that does not run a formatter and does
not type-annotate at all — would see a different mix. For this repo the only defensible subset is
ten findings: `no-chained-type-assertions` (4 in `src`) plus `no-known-value-widening` (6 in
`src`). Both are already reportable by reasoning about the code, and the 4 chained assertions in
`src` are not defects: one is a span-record cast, and the rest are in `runtime.ts` plumbing.

The rules themselves are not the problem. The problem is that they encode one author's taste about
`unknown` and JSON records, and this repo's taste is the opposite at its boundaries on purpose.

## Limits

- One adjudicator, unblinded. The "0 material" count is a reading, and the marginal band (5 rows)
  is where a second reader would most likely move things.
- Five modules' worth of context was not read for each row; a row was judged from its expression
  plus enough surrounding lines to identify the enclosing function.
- No Effect rules: the tree has no Effect. A repo that does would see five more families.
- The plugin was run from `/tmp/as-run`, outside the repo, with `@oxlint/plugins` at the host
  version. A vendored copy pinned to `@oxlint/plugins@1.78.0` was **not** tested against oxlint
  1.90.0; the 1.90.0 pairing is what was measured.
