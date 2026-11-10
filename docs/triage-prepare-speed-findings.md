# Prepare is ~7 minutes a ticket: verified findings and action items

Verified against `60b82cb` (origin/main) on 2026-11-10. Sample: the one completed batch record in this
repo — `mypi-tasks/000-batches/0012-docs-414/`, ticket #414, kind `writer`, run 2026-11-06.

Question: `mypi-batch prepare` spent 6.9 minutes on one ticket. Is that inherent to the gate, or is
part of it work nothing consumes?

Short answer: **most of the paid time is work no downstream consumer reads.** The gate itself (run a
command per claim, have a second model re-run it) is not what dominates. The prompt's other five
sections, a reading list inherited from the standalone phase, and a second DoD check are.

## 1. What is measured, and what is not

| Measurement                                  | Value                            | Source                                                  |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| triage call                                  | 354,582 ms                       | `tickets/414/acceptance.json` → `durations.triage`      |
| verifier call                                | 41,616 ms                        | `durations.verifier`                                    |
| repair round                                 | 10,143 ms                        | `durations.repair` (the ticket hit this path)           |
| re-verify                                    | 6,480 ms                         | `durations["re-verify"]`                                |
| prepare total                                | 412,821 ms = **6.88 min**        | sum of the four                                         |
| prepare cost                                 | $0.08796                         | `costUsd`                                               |
| claim rows / shell invocations in the reply  | **11 rows / 12 commands**        | `report.md`                                             |
| reply size                                   | 6,143 bytes                      | `report.md`                                             |
| run total                                    | 917,272 ms = **15.3 min**, $0.48 | `tickets/414/run.json`                                  |
| run, first peer registered → `FINALIZED`     | 900,718 ms = 15.0 min            | `run-details/conversation.jsonl` first/last `timestamp` |
| run, worktree start → first `AGENT_REGISTER` | **16.6 s**                       | same, minus `run.json` `durationMs`                     |
| cycle                                        | 22.2 min, $0.568                 | 6.88 + 15.3                                             |

Not measured, and therefore not claimed anywhere below:
- **Turn count and token usage per paid call.** `collectReply` (`src/batch/agent.ts:118`) keeps only
  reply text and cost; the JSON stream it parses carries per-message `usage` and per-turn events, and
  both are dropped. `acceptance.json` records wall time only, so today no 7-minute figure can be
  attributed to a turn.
- The 21–36 turns / 60–95k tokens per issue in
  `docs/explorations/triage-automation/triage-loop-brief.md` are **standalone prompt tests**, not
  batch prepares. They bound the shape, not this number.
- Whether the batch's triage agent actually opened the three files its prompt tells it to read. The
  instruction is in the prompt (`triage-prompt.md:30-32`); there is no transcript, because the stream
  is discarded (previous item).

## 2. Claims from the earlier analysis, re-checked

| Claim                                                                               | Evidence                                                                                                                                                                                                                                                                                | Result                                                                                                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reply had 10 claim rows and 13 commands                                             | `rg -n '^\|' report.md` → 13 table lines = header + separator + **11** rows; the command column carries **12** shell invocations                                                                                                                                                        | **corrected**: 11 rows, 12 commands                                                                                                                   |
| Verifier did the same rows in 6 turns / 41.6 s                                      | `triage-verifier.md` calibration: "6 turns and ~20k tokens total" — measured on **6-row** tables, not this run                                                                                                                                                                          | **corrected**: 41.6 s for 11 rows is measured; this run's turn count is unknown                                                                       |
| `commentText` publishes only kind, slug and criteria                                | `src/batch/prepare.ts:248-261`                                                                                                                                                                                                                                                          | confirmed                                                                                                                                             |
| `parseTriageReport` reads 4 sections + the KIND line                                | `src/batch/report.ts:431-440`; `rg 'Need\|Fix\|Open questions' src/` → no hits                                                                                                                                                                                                          | confirmed: `## Need`, `## Fix`, `## Open questions` have no consumer                                                                                  |
| Body DoD overwrites the reply's criteria                                            | `src/batch/prepare.ts:987-989`                                                                                                                                                                                                                                                          | confirmed                                                                                                                                             |
| `No DoD` is short-circuited when the body states one                                | `src/batch/prepare.ts:993`                                                                                                                                                                                                                                                              | confirmed                                                                                                                                             |
| The verifier checks the DoD again, after triage self-checked it (prompt step 5)     | `src/batch/report.ts:708-722`; `triage-prompt.md` step 5                                                                                                                                                                                                                                | confirmed                                                                                                                                             |
| Citation check is skipped for a body-owned DoD                                      | `src/batch/report.ts:724`                                                                                                                                                                                                                                                               | confirmed                                                                                                                                             |
| The prompt tells the agent to read 3 files first                                    | `triage-prompt.md:30-32`                                                                                                                                                                                                                                                                | confirmed as an instruction; execution unverified                                                                                                     |
| Cost of that reading list                                                           | `triage SKILL.md` 6,558 B · `issue-tracker.md` 1,938 B · `agent-config-guide.md` 58,024 B; §10 starts at line 560; lines 1–560 are 48,454 B                                                                                                                                             | confirmed by size; **corrected** detail: one `read` truncates at 50 KB (~575 of 710 lines), so §10 is cut mid-section and costs a second, offset read |
| The paid child runs at pi's default thinking level, not the operator's              | `agentConfigDir` copies `auth.json`, `models.json`, `models-store.json` and never `settings.json` (`src/batch/sandbox.ts:139-149`); pi's `defaultThinkingLevel` default is `"medium"` (`pi docs/settings.md:15`); the operator's `modelThinkingLevels` (`high`) therefore never applies | **corrected**: the config dir is credentials + catalog, not auth-only; the thinking conclusion holds                                                  |
| `piArgs` cannot set a thinking level                                                | `src/batch/agent.ts:91-104` passes no `--thinking`; the flag exists (`pi docs/cli.md:69`)                                                                                                                                                                                               | confirmed                                                                                                                                             |
| Tool calls from one assistant message may run in parallel                           | `pi docs/extensions.md:236`                                                                                                                                                                                                                                                             | confirmed: batching commands in one turn is available, and the prompt does not ask for it                                                             |
| Triage is 8.5× the verifier on the same rows                                        | 354,582 / 41,616 = 8.52                                                                                                                                                                                                                                                                 | arithmetic confirmed; attribution unconfirmed (§1)                                                                                                    |
| Bounds: 15 min per call, 5 min repair/re-verify, 30 min per prepare, 30 min per run | `SITE_SHARE`/`DEADLINE_SHARE` (`src/batch/prepare.ts:76-88`); `mypi-batch.yaml:26,30`                                                                                                                                                                                                   | confirmed                                                                                                                                             |

## 3. What triage produces, and who reads it

| Output                                   | Consumer                                                                           | Needed when the body states the DoD                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `## Claim checks` table                  | verifier prompt input; `commandSafetyFaults` (`prepare.ts:1009`)                   | **yes** — the only irreplaceable output               |
| `KIND:` line                             | `prepare.kind_templates[kind]` (`prepare.ts:1085`)                                 | only when not pinned (`--kind`, `request.yaml`, #465) |
| `## Definition of Done`                  | overwritten by the body's list (`prepare.ts:987`)                                  | no                                                    |
| `## Need`, `## Fix`, `## Open questions` | nothing parses them; nothing posts them                                            | no                                                    |
| Verdict `run`/`inline`                   | parsed, unused; only `No DoD` matters and it is short-circuited (`prepare.ts:993`) | no                                                    |

Four leftovers follow, each with its owner line:
1. **The phase's purpose was dropped; its prompt was not.** `triage-loop-brief.md` D1: "the phase's
   goal is the investigation, not the DoD." #469 then made the body own the DoD, and `prepare.ts:987`
   discards what the prompt still spends turns producing.
2. **A standalone phase's reading list inside a batch call.** `triage-prompt.md:30-32` sends the agent
   to a triage-roles skill, a tracker doc and a template-authoring recipe. The batch writes no brief
   and no template. In a clone of a repo without those files, the agent spends turns discovering that.
3. **Every command is run twice.** The author runs 12 commands to write the table; the verifier re-runs
   all 12. The duplication is the trust model (different model family; zero false matches measured)
   and should stay. The expensive half is the _authoring_ pass, not the re-run.
4. **The DoD is checked twice on a body-DoD ticket.** Triage step 5 self-checks the criteria; the
   verifier then returns one verdict per criterion (`report.ts:708-722`). The verifier's is the gate.

## 4. Action items

Quality first: none of these weakens a gate. Each names the property it must preserve.

### A1 — Record turns and tokens per paid call (do this first)

`collectReply` already parses the stream; keep per-message `usage` and the assistant-message count,
and put per-site `{turns, inputTokens, outputTokens, costUsd, durationMs}` into
`acceptance.json`/`refusal.json`.
- Preserves: every existing gate and record field.
- DoD: a prepare's record carries per-site turn and token counts; a site that made no call has the
  fields absent, never `0` (the #384 rule); a unit test asserts the absent-not-zero distinction.
- Why first: A2–A5 are arguments until this exists.

### A2 — Drop the read-first list from the batch's triage prompt

Remove `triage-prompt.md:30-32`'s three-file list, or make it conditional on the standalone use those
documents were written for. Nothing in those files is needed to check a claim.
- Preserves: step 1's "a command for every claim", the claim-table shape, `No DoD`.
- DoD: the fenced prompt names no file to read before investigating; a guard test asserts the clause is
  gone; A1's per-site numbers show the delta.

### A3 — When the body owns the DoD, stop asking triage to author one

The "THE DoD IS GIVEN" block (`prepare.ts:363-377`) already tells the agent to return the criteria
unchanged. Extend it to drop the authoring and self-check obligations and the Need/Fix/Open-questions
prose, leaving the claim table, the KIND line and the given criteria. The parser still requires
`## Definition of Done` and `## Verdict` headings (`report.ts:89-93`), so either keep them empty or
relax the parser in the same change.
- Preserves: criteria still come from the body; the verifier still gates each criterion.
- DoD: with a body DoD, the batch prompt asks only for verified claims, a kind and the given criteria;
  the acceptance-path test passes unchanged; A1 shows the delta.

### A4 — Expose a thinking level for the paid calls

`piArgs` (`agent.ts:91`) gains `--thinking <level>`; policy gains a per-site level; the default stays
`medium`, so nothing changes until a measurement says otherwise.
- Preserves: nothing to preserve; this is a knob.
- Honest risk: judgement is the product here. The property to re-measure after any level change is the
  verifier's zero-false-match calibration, not speed.
- DoD: policy accepts a level per site; the spawned argv carries it; an invalid level fails preflight
  rather than at the provider.

### A5 — One DoD check, not two

On a body-DoD ticket, remove triage's step-5 self-check; the verifier's block is the gate.
- Preserves: one verdict per criterion, quoted verbatim, from a different model family.
- DoD: a body-DoD prepare's prompt no longer asks triage to judge the criteria; the verifier still
  returns one verdict per criterion; the prompt-copy guard (`test/integration/guardrails.test.ts`)
  still derives every copy.

### Not action items

- Removing claim verification. That is what caught the tickets whose fix could not reach the failing
  mechanism (#132, #138, #125). At 15 min and $0.48 a run, a false "this is fine" is the expensive
  failure; a slow prepare is not.
- Implementing the verifier's row sampling (a known limit in `docs/batch-guide.md`). It saves the cheap
  call and weakens the gate.
- Anything that changes what the run is judged against.

### Deliberately deferred, needs a decision

Merging triage and verifier into one pass would roughly halve the paid time and destroys the
independent-model property every calibration was measured against. Do not ship it as a speed fix; it
is a redesign.

## 5. Recommend

Ship A1 alone first. It is a record change with no gate and no prompt in it, and it turns A2–A5 from
arguments into measurements. Then A2 and A3 together — the two changes that remove work no consumer
reads — and A4/A5 only with numbers in hand.

## 6. Reproduce

```sh
cat mypi-tasks/000-batches/0012-docs-414/tickets/414/acceptance.json    # durations, cost
cat mypi-tasks/000-batches/0012-docs-414/tickets/414/run.json           # outcome, durationMs
head -1 mypi-tasks/b-0012-docs-414-t414/run-details/conversation.jsonl  # first timestamp
tail -1 mypi-tasks/b-0012-docs-414-t414/run-details/conversation.jsonl  # FINALIZED timestamp
rg -n '^\|' mypi-tasks/000-batches/0012-docs-414/tickets/414/report.md  # 11 claim rows
sed -n '30,32p' docs/explorations/triage-automation/triage-prompt.md    # the read-first list
sed -n '431,440p' src/batch/report.ts                                  # what the parser reads
sed -n '987,995p' src/batch/prepare.ts                                 # body DoD override, No-DoD short-circuit
sed -n '139,149p' src/batch/sandbox.ts                                 # the child's config dir
```
