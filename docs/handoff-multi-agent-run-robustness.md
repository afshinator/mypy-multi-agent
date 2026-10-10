# Handoff — multi-agent run robustness (from pi-nobash runs 1–2)

**Target repo:** `multi-agent` (mypy-multi-agent) at `/Users/afshin/Documents/dev/multi-agent`
**Source of evidence:** two real runs of the pi-nobash implementation task (`task-implement-1`, `task-implement-2`) under this harness.
**Purpose:** a TODO list of harness and config-doc changes that would have prevented the observed failures.
**Classification tags:** `[CODE]` = multi-agent source change; `[CONFIG]` = session.yaml change; `[DOC]` = `docs/agent-config-guide.md` (or template) change.

## Summary

| TODO | Item | Classification | Severity |
|---|---|---|---|
| MT-1 | Preflight each agent's model before spawning peers | `[CODE]` + `[DOC]` | high |
| MT-2 | Detect "connected but mute" peers | `[CODE]` + `[DOC]` | high |
| MT-2a | Recover a mute peer: stop it and reassign its work | `[CONFIG]` + `[DOC]` | high |
| MT-2b | `restart_agent(agentId, model?)` to swap a bad model in place | `[CODE]` | medium |
| MT-2c | Author-predefined standby agents plus a spawn bound | `[CODE]` | low |
| MT-3 | Stop peers at a work-order boundary, and size the threshold | `[CONFIG]` + `[DOC]` (+optional `[CODE]`) | high |
| MT-4 | Do not accept an empty FINAL_REPORT as a deliverable | `[CONFIG]`/`[DOC]` (+optional `[CODE]`) | medium |
| MT-5 | Align peer/await timeouts with real work | `[CONFIG]` + `[DOC]` | medium |
| MT-6 | Warn when two peers share a model slug | `[DOC]` (+optional `[CODE]`) | medium |
| MT-7 | Size roster and budgets to scope | `[DOC]` | medium |

MT-3 through MT-7 are primarily **config + guide** work. The exact guidance to add to `docs/agent-config-guide.md` is collected in §"Config and guide additions" below so the guide can be updated without re-deriving it.

---

## MT-1 — Preflight each agent's model before spawning peers

**Problem.** A model slug can resolve in the catalog and still be unusable for the operator's key (entitlement, access tier, region). The peer then connects successfully and returns empty output with zero usage, so nothing looks broken until the supervisor gives up on it.

**Evidence.** Run 1: `pi_core` on `anthropic/claude-sonnet-5-5` answered four prompts with empty text and `usage {cost: 0, tokens: 0}`, made 0 tool calls, and was declared crashed by the supervisor. Phase 1 had to be reassigned to `data_git`; the run ended `dod:false`. The same role on `fireworks/accounts/fireworks/models/glm-5p3-flash` in run 2 was the top producer (189 tool calls, $0.42). `docs/model-catalog.md` lists slugs but does not verify them against the operator's key, and it carries no drift warning; the harness resolves a slug through `ctx.modelRegistry` only for pricing (`isFreeModel`), never for auth.

**Proposed change.**
- `src/pi/extension.ts`: after `parseSessionConfig` and before spawning peers (around the `applySupervisorModel` / config-commit path, ~lines 150–175), verify each distinct agent model:
  1. resolve it through `ctx.modelRegistry` (already done for `isFreeModel`), and
  2. verify provider auth: `ctx.modelRegistry.hasConfiguredAuth(model)` is the in-process check (same `ModelRegistry` already used by `isFreeModel`); `pi auth check --json --provider <provider>` is the equivalent CLI check. Neither is called anywhere in the harness today.
- On failure, abort the run with a message naming the agent id, slug, and reason; do not spawn that peer. Optionally offer `session.verify_models: "strict" | "warn" | "off"` if some operators want to proceed anyway.
- A live one-token probe is an optional stronger check; the auth+resolve pair is free and catches the common cases first.

**Why it fixes it.** It converts a silent, mid-run, budget-consuming failure into a fail-fast startup error. The operator sees which slug is unusable before any peer budget is spent, instead of discovering it from a run that ends `dod:false`.

**Acceptance.** A config with an unauthorized/unresolvable slug aborts with an error naming the agent and slug, and spawns no peers; a valid config is unaffected. Cover with a faux provider.

---

## MT-2 — Detect "connected but mute" peers

**Problem.** `AGENT_CRASHED` fires only on heartbeat timeout or disconnect (`src/runtime/runtime.ts` ~393, ~510). A peer that stays connected and answers `""` with zero usage produces no failure event at all; the supervisor can only infer it.

**Evidence.** Run 1 `pi_core`: four consecutive empty `RESPONSE` frames with `usage {cost:0, tokens:0}` and no `AGENT_CRASHED` in `conversation.jsonl`. Run 2 `reviewer`: one empty response, coinciding with a 1800 s await timeout.

**Proposed change.**
- `src/peer/peer-harness.ts`: after `runWorkOrder` exhausts its retry policy (`RetryPolicy`, ~lines 30–52), if the result is empty *and* usage is zero/null, send a distinct final frame rather than a normal empty `RESPONSE`/`FINAL_REPORT`. Run 1's four empty `pi_core` frames were `PROMPT` replies, not work orders — no `WORK_ORDER` was dispatched to `pi_core` — so the `PROMPT` arm of `handleInboundLine` needs the same check; the work-order path alone would not have caught it.
- `src/contracts/a2a-schema.ts`: add an event type, e.g. `AGENT_UNUSABLE` with `{ agentId, reason: "empty model output", attempts }`.
- `src/runtime/runtime.ts`: on that event, stop the peer with the same reason and emit it to `conversation.jsonl` (mirroring `AGENT_CRASHED` at ~406).
- `src/pi/supervisor-prompt.md`: instruct the supervisor to treat `AGENT_UNUSABLE` as "this peer cannot run", reassign its work once, and abort the run if no viable implementer remains.

**Why it fixes it.** The failure becomes explicit, logged, and actionable. It also cuts the detection cost: the supervisor currently spends several prompts and retry pauses before concluding a peer is useless.

**Acceptance.** Two consecutive zero-usage empty responses emit the new event and stop/flag the peer; one empty response still triggers the existing retry only. Cover with a faux provider that returns empty.

**Recovery when a peer is unusable.** Three tiers, in increasing cost:

- **MT-2a — stop and reassign (no code).** On `AGENT_UNUSABLE` (or the existing heartbeat crash), call `stop` on the peer (`src/pi/extension.ts:324`) and re-`dispatch_work_order` its work to a live peer that has the right permissions (`:214`). Run 1 used this manually — Phase 1 moved from the mute `pi_core` to `data_git`. Add the rule to `src/pi/supervisor-prompt.md` and the guide: never leave an unusable peer idle, never absorb its work into the supervisor, and prefer reassignment to stalling. Because `session.yaml` fixes the roster, reassignment is only possible if another peer has the required permissions, and the prompt must also transfer file ownership in `plan.md` so two peers cannot write the same file. This recovers the work but not the lost capacity: with one implementer, the run is bounded by the survivors.
- **MT-2b — `restart_agent(agentId, model?)` (`[CODE]`).** Respawn one peer in its existing slot with a different model, reusing its config file, pane, and budget entry. Much smaller than adding an agent because nothing new must be registered in `BudgetEnforcer` (`src/runtime/runtime.ts:150-158`) or the registry. Directly targets MT-1: a slug that is present but unusable is swapped for one already proven with the key.
- **MT-2c — standby agents and a spawn bound (`[CODE]`).** Let `session.yaml` declare author-owned `standby: true` agents that are validated and budgeted at load but spawned only on demand, plus a new `spawn_agent` tool. Model-authored agent specs are rejected on purpose — that would hand the model control over its own roster. Bound spawns per run (for example, one replacement per agent) so a systemic provider failure cannot burn the budget on replacements.

**Caveats that apply to all three.** A replacement re-briefs from scratch (token cost, lost context); a killed peer's partial edits remain in the tree with no rollback, so the replacement must reconcile actual state before continuing; any new peer must be included in `session.max_cost_usd` accounting; and a replacement must inherit the same `plan.md` file ownership as the peer it replaces.

---

## MT-3 — Stop peers at a work-order boundary, and size the threshold

**Problem.** `agent_stop_threshold_percent` stops a peer the instant cost% or token% crosses the threshold (`src/budget/budget-enforcer.ts` ~40–46; enforced in `runtime.ts` `enforceBudget` ~429–440). If that fires mid-work-order, the peer's task is truncated, and the supervisor may then do the implementation itself.

**Evidence.** Run 1: `data_git` stopped at `1.198 / 1.30 = 92%` and `validation_tests` at `0.818 / 0.85 = 96%`, both with reason `budget threshold`. Both stopped before the reviewer's defects were fixed; the supervisor applied D1/D2/D3 itself. That work is invisible to the peer budget and is a role inversion.

**Proposed change.**
- `[CONFIG]`/`[DOC]`: guidance to set the threshold high (95–100) for implementers, size `max_cost_usd` from observed per-peer spend, and reserve budget for one reviewer-driven fix round.
- `[CODE]` (optional): a `session.stop_at_work_order_boundary: true` option so a peer that crosses the threshold finishes its current work order and stops before accepting the next, instead of being cut off mid-task.

**Why it fixes it.** Peers finish coherent units of work, the supervisor stays a coordinator, and the peer budget reflects the real implementation cost.

**Acceptance.** With the option on, an over-threshold peer completes its current work order and then stops; without it, current behavior is unchanged.

---

## MT-4 — Do not accept an empty FINAL_REPORT as a deliverable

**Problem.** A peer can stop (e.g. hit the budget threshold) and still file a `FINAL_REPORT` with an empty `report`. The harness stores it and the supervisor treats it as a deliverable.

**Evidence.** Run 1 `data_git` filed `FINAL_REPORT` with `report: ""` after its budget stop; `findings.md` recorded an empty section for it.

**Proposed change.**
- `[CODE]` (optional): reject or annotate an empty `report` at the bus/schema boundary, or mark it in `findings.md` (e.g. `_(empty report — peer stopped before reporting)_`).
- `[CONFIG]`/`[DOC]`: the session prompt should instruct the supervisor to re-ask a peer that files an empty report before accepting it. (The pi-nobash task config already carries this rule; it belongs in the default supervisor prompt or the guide.)

**Why it fixes it.** An empty report hides whether work was done and blocks evidence-based attestation; annotating it keeps the loss visible instead of silent.

**Acceptance.** An empty `FINAL_REPORT` is annotated (or rejected), and the supervisor is instructed to re-ask.

---

## MT-5 — Align peer/await timeouts with real work

**Problem.** `peer_prompt_timeout_ms` defaults to 120000 and the config set 180000, but real peer turns (running the full test suite, a provider-backed CLI test, a long review) exceed it. Timeouts cost wall-clock and inflate the error log.

**Evidence.** Run 1: `ERROR correlation-timeout to data_git 240000 ms` and `300000 ms`. Run 2: `ERROR correlation-timeout 1800000 ms correlation await:reviewer timed out`. Neither was a real peer failure.

**Proposed change.**
- `[CONFIG]`/`[DOC]`: guidance to derive `peer_prompt_timeout_ms` from measured peer turn durations, and to pass an explicit `timeoutMs` on `send_prompt`/`await_response` for known-long calls (both already accept it; `src/pi/extension.ts` ~256–282).
- `[CODE]` (optional): progress heartbeats for long turns so the supervisor can distinguish "still working" from "stuck".

**Why it fixes it.** Legitimate long jobs stop being recorded as errors and the supervisor stops waiting on a timeout it will hit anyway.

**Acceptance.** An explicit `timeoutMs` overrides the session default (already supported); guide §5 documents choosing it from measured durations.

---

## MT-6 — Warn when two peers share a model slug

**Problem.** Two peers on the same provider/model share one point of failure; a single outage or entitlement problem takes out multiple peers at once.

**Evidence.** `task-implement-2` configures `pi_core` and `validation_tests` both on `fireworks/accounts/fireworks/models/glm-5p3-flash` (task-implement-3 has only `pi_core` on that slug; its other peer is `reviewer` on `openai/gpt-6-luna`). Runs 1–2 already showed that one bad slug can cost a peer entirely (MT-1).

**Proposed change.**
- `[DOC]`: guidance to spread critical peers across providers/models where practical.
- `[CODE]` (optional): a non-fatal config-load warning when two agents share a slug.

**Why it fixes it.** It makes the correlated-failure risk visible at authoring time instead of during a run.

**Acceptance.** Guide notes the risk; optional warning emitted when duplicate slugs exist.

---

## MT-7 — Size roster and budgets to scope

**Problem.** An over-provisioned roster carries idle budget while working peers are under-funded; cost then correlates poorly with outcome.

**Evidence.** Run 1 allocated `pi_core` $1.55, which spent $0 while `data_git` and `validation_tests` were stopped on threshold. Run 2 rebalanced (pi_core $1.30, data_git $1.20, validation_tests $0.90, reviewer $0.85) and every peer was productive. Run 2 cost 41% of run 1 and delivered more (11/11 vs 7/11). Combined spend for the full package: $3.36.

**Proposed change.**
- `[DOC]`: guidance — size the roster to the work shape (a bounded cleanup needs two peers, not four); keep the sum of peer budgets at or below `session.max_cost_usd`; keep the reviewer separate, cheap, and independent; allocate by expected work weight, not evenly.

**Why it fixes it.** It removes idle spend, avoids starving the peers doing the work, and makes budget a meaningful signal.

**Acceptance.** Guide §5/§10 documents the sizing rule with the run-1/run-2 comparison as the worked example.

---

## Config and guide additions (for `docs/agent-config-guide.md`)

These are configuration/documentation items, not code. Recommended placement: **§5 Budgets, free models, and enforcement** (line ~211) for MT-3/MT-5/MT-6/MT-7, **§10 Authoring a template** (line ~356) for MT-7, and **§12 Caveats** (line ~404) for MT-1.

1. **Threshold guidance (MT-3).** `agent_stop_threshold_percent` applies to cost% *and* token%, first bound wins (`src/budget/budget-enforcer.ts`), and stops the peer immediately. For implementers set 95–100 so a work order is not truncated; reserve budget for one fix round after reviewer findings. Example: implementer peers 95, reviewer 100.
2. **Budget sizing (MT-7).** Sum of peer `max_cost_usd` ≤ `session.max_cost_usd`; allocate by work weight; a four-peer roster on a small task wastes budget. Worked example: run 1 (4 peers, one idle $1.55, 56% spent, 7/11) vs run 2 (rebalanced, 23% spent, 11/11).
3. **Timeout guidance (MT-5).** `peer_prompt_timeout_ms` is the default for `send_prompt`/`await_response`; both accept a per-call `timeoutMs`. Set the session default from measured turn durations; pass an explicit larger `timeoutMs` for known-long calls (full suite, provider-backed tests). Observed: 240000/300000 ms correlation timeouts and one 1800000 ms await.
4. **Model diversity (MT-6).** Avoid two active peers on the same provider/model slug when a run must survive one provider failing; document the warning if implemented.
5. **Model preflight caveat (MT-1).** Strengthen the existing `docs/model-catalog.md` caveat in §12: a slug present in the catalog can still be unauthorized for the key; verify with `pi auth check --json --provider <provider>` before a run, and prefer models already proven with that key.
6. **Empty-report rule (MT-4).** State in §8/§12 that an empty `FINAL_REPORT` is not a deliverable and the supervisor must re-ask before accepting it.
7. **Mute-peer recovery (MT-2a).** State in §6/§12: on an unusable peer, `stop` it and reassign its work to a live peer with the right permissions; never absorb its work into the supervisor; transfer file ownership in `plan.md` on reassignment. Note the roster limit — with a single implementer the only no-code option is reassignment; in-place model swapping needs `restart_agent` (MT-2b).

## Appendix — run data

| Metric | Run 1 (`task-implement-1`) | Run 2 (`task-implement-2`) |
|---|---|---|
| Outcome | failure, 7/11 | success, 11/11 |
| Total cost (peers + supervisor) | $2.38 (peers $2.08, supervisor $0.30) | $0.98 (peers $0.88, supervisor $0.10) |
| Peer budget | $4.25 | $4.25 |
| Tool calls | 532 (pi_core 0, data_git 167, validation_tests 266, reviewer 99) | 411 (pi_core 189, data_git 21, validation_tests 135, reviewer 66) |
| Empty responses | pi_core 4, data_git 1 | reviewer 1 |
| `ERROR` events | 3 (two correlation timeouts + one send-to-stopped) | 1 (1800 s await timeout) |
| `STOP_AGENT` | 2 (`budget threshold`) | 0 |
| `AGENT_CRASHED` | 0 (the mute peer produced no crash event) | 0 |
| Tool calls / dollar | 256 | 419 |

**Most important:** MT-1, MT-2, and MT-2a address the one failure class that cost run 1 its Definition of Done — a peer that connects and returns nothing. MT-1 catches an unusable slug before any spend, MT-2 makes the mute state explicit and logged, and MT-2a recovers the work using tools that already exist; everything else is tuning.
