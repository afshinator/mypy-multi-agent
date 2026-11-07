# Free and unpriced models

> **This note is older than the model data it reasons about.** The findings below are dated
> where they were measured (2026-10-14 to 2026-10-29). Slugs, free tiers, balances and prices
> drift. Also read the catalog: `../../model-catalog.md`
> (a sibling checkout at `~/Documents/dev/model-catalog.md`), plus the cost view in
> `MODEL-MAP.md` and reasoning levels in `EFFORT-LEVELS.md`. Where this file and that catalog
> disagree, the catalog wins and a live probe settles it.

How to check a slug yourself: `pi auth check --model <slug>` for resolution and auth, then
`printf 'pong' | pi -p --model <slug>` for a real completion.

## No catalog price is not free

A model with **no catalog price** is treated as `$0` by pi (`isFreeCost`: input and output rates
both 0, resolved through the model registry). That is an _unpriced_ estimate, not verified free
billing: cost thresholds can never trip for it, and `final.md` still prints the resulting `$0`.
`max_tokens` is therefore required unless the agent declares `allow_unbounded: true`, an explicit
accept that the peer has no token bound (`docs/agent-config-guide.md` §3 holds the schema rows).

## The `$0` is silent

Verified 2026-10-29: every run on a commandcode slug reported `total_cost_usd: 0` while the
provider billed for it, because `~/.pi/agent/models.json` declared those models with no `cost`
object. Prices live in that machine config, not in this repository, so a fresh machine shows the
same `$0`. When a run reports `$0` for work you know was billed, add
`cost: {input, output, cacheRead, cacheWrite}` ($/M) to the model's entry there.

Derived from the provider's usage page, the slugs this repository uses cost, per million tokens:
`deepseek-v4-flash` 0.0061 in / 1.33 out, `deepseek-v4-pro` 0.0235 / 2.07, `gpt-6-luna` 0.0193 /
0.4587, all measured 2026-10-29. The input rates are effective and cache-inclusive, because these
calls send ~500 input tokens per output token and the cached share bills at a few percent of list.
`zai-org/GLM-5.3` is the exception: no billing row for it has ever appeared on that page despite a
3.8 M-token run, so its entry (0.2 / 0.629) is the doc's number and may be off by 2x.

## `max_tokens` is the only bound that applies

It counts **total tokens minus cache reads** (`src/budget/usage-accounting.ts#getAgentBoundTokens`,
RT-1). A tool-loop run resends the context on every request and reports those re-reads as cache
reads, so counting them made a small cap look exhausted while the peer had barely written
anything. Size an unpriced peer in the millions and set `agent_stop_threshold_percent: 100`, or
use priced models.

The older reading, that cache reads burn the same quota as fresh tokens, predates RT-1 and
survives in the `templates/free-research.yaml` header. It is wrong now.

## `$0` does not mean reachable, and does not mean cheap

Verified 2026-10-14 by making a real completion per slug: every `opencode/*-free` slug returns
`403 FreeTierError` (the free tier is restricted to OpenCode's own client), two more return
`400 "Model is unavailable"`, one is `410 deprecated`. Only openrouter's `:free` slugs answered,
and those throttle (`429`). `verify_models: strict` checks resolution and auth, not reachability
or funds.

An unpriced roster still costs, in wall clock and in damage. On a 4-file documentation task, two
free writers burned ~3.5M tokens across 42 min (93% of it supervisor-blocked), one destroyed both
of its own target files with whole-file `write` calls before its first work order (recovered only
by `git checkout --`), and it then hung twice, needing three `restart_agent` swaps. Use free peers
only for small, bounded, single-writer, git-recoverable edits, keep one **paid** verifier and
attester (a free cross-check does catch real errors, but the gate should not be free), and keep
the work on an unmerged branch.

## Parsing a config with unpriced peers

`parseSessionConfig(input, isFreeModel = () => false)` defaults the lookup off, which makes the
unpriced-model rule unreachable: a config whose peers run on catalog-free models passes a
one-argument parse and is then rejected at launch with
`agents[].<id>: unpriced model "..." requires max_tokens (or allow_unbounded: true)`. Reproduce
the launcher instead (`src/pi/extension.ts` `freeModelLookup`): resolve each slug through the
model registry, ask `isFreeCost(model.cost)`, pass that as the second argument. Verified
2026-10-27 on three `commandcode/*` peers: one-argument parse `ok`, launch-parity parse rejected
all three until each carried `max_tokens`.
