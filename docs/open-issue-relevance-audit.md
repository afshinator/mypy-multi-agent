# Open-issue relevance audit — #90, #91, #94, #41, #10

Date 2026-10-28, HEAD `205cb70` (`205cb708cfd61327e18a775a172c2e17cb3e1b4f`, "Check documented code citations, and scan every doc for links"). Scope: whether each of the repository's five open issues still describes the tree and the project's direction. `gh issue list --state open` returns exactly those five, so this is the whole open set. Every claim below was re-run or re-read against this commit. `run-details/` and `quality/` are gitignored (`.gitignore:6`, `:17`), so the artifact counts in this note come from the working checkout's on-disk directories, which are not in the tree.

## Verdicts

| Issue                                                       | Labels                                           | Verdict         | Reason                                                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #90 — link a post-mortem to the improvement that follows it | `analysis`                                       | PARTIALLY-STALE | `analysis` is genuinely absent from `ImprovementRecord`, but three body facts are wrong and the `#97` blocker is cleared.                                                           |
| #91 — run one post-mortem end to end on real runs           | `analysis`                                       | STILL-RELEVANT  | Template byte-identical to filing, never executed, every DoD premise holds; two counts drifted.                                                                                     |
| #94 — document the task type and its template               | `analysis`                                       | PARTIALLY-STALE | The doc gap is real; a line citation, a "they disagree" claim, and an entry count are wrong.                                                                                        |
| #41 — no peer can open a prompt                             | `enhancement`, `ready-for-human`, `priority:low` | STILL-RELEVANT  | Defect verified open at HEAD; one cited source doc has since been deleted.                                                                                                          |
| #10 — run-quality feedback loop                             | `enhancement`, `needs-triage`                    | PARTIALLY-STALE | Epic still matches direction and the loop is still unclosed, but body specifics are stale and the triage label is stale. Not obsolete: its stated end state was never demonstrated. |

## Per-issue detail

### #90 — Analysis: link a post-mortem to the improvement that follows it

**The issue claims:** `src/scorecard/improvements.ts:23` defines `ImprovementRecord` as `{ change, class, beforeCount, afterCount?, taxonomyVersion? }`; `quality/` holds only `opt-in.json`; the ledger arrives with #97; the proposal is one optional `analysis?: string` field.

**True at HEAD.**
- `ImprovementRecord` is exactly that shape, with no `analysis` field (`src/scorecard/improvements.ts:23-34`). `rg -n 'analysis' src/` exits 1.
- `measureImprovement` (`:63`), `measureAll` (`:110`), `renderImprovements` (`:123`), `readImprovements` (`:155`), `writeImprovements` (`:164`) all exist.

**Stale at HEAD.**
- "Neither file exists on disk yet: `quality/` holds only `opt-in.json`." `quality/ledger.jsonl` exists on disk, 3 lines, mtime Oct 23 15:01, gitignored at `.gitignore:17`. `quality/improvements.jsonl` genuinely does not exist anywhere. In a fresh clone the original sentence is still true, because the ledger is ignored.
- "The ledger will exist once #97 appends it at finalize." #97 is CLOSED COMPLETED (2026-10-28T21:31:46Z). The append is live and default-on: `src/runtime/runtime.ts:693-699` under `this.config.session.record_scorecard`, and `record_scorecard: z.boolean().default(true)` (`src/contracts/session-schema.ts:76`). No opt-in step remains.
- Acceptance criterion 1, "accepted and preserved by `readImprovements()` / `writeImprovements()`": preservation happens in `sanitizeRecord` (`src/scorecard/improvements.ts:142-153`), which rebuilds the object field-by-field and drops anything unknown. `writeImprovements` (`:164-171`) never writes the records file at all — it measures the records and writes `renderImprovements(...)` to a `.md` output path. The AC names the wrong function.
- Acceptance criterion 4, "the improvements section of `docs/agent-config-guide.md`": `rg -i improvement docs/agent-config-guide.md` exits 1. Neither "improvement" nor "ledger" nor "quality/" appears anywhere in that guide or in `README.md`. The guide documents the scorecard flag at `docs/agent-config-guide.md:102`, but not the loop or its files; §7 "Run artifacts" (`:430-446`) also omits `scorecard.json`.

**Undefined premise.**

`analysis?: string` is documented as "the analysis run id". No run-id concept exists in the artifacts: `RunScorecard` has no id field (`src/scorecard/scorecard.ts:45-73`), and the guide says `session.id` is a "declarative run id; currently not surfaced in the artifacts" (`docs/agent-config-guide.md:95`). In practice run identity is the task directory name. The issue should name that form explicitly.

**What the body needs.** Delete the disk-state sentence or qualify it as "in a fresh clone"; drop #97 from the blocker list; restate AC1 as "`sanitizeRecord`/`readImprovements` (`src/scorecard/improvements.ts:142-155`) preserve `analysis`, and it round-trips through the hand-authored JSONL"; replace AC4's nonexistent guide section with `docs/agent-config-guide.md` §7 "Run artifacts"; state that the id is the analysis run's task-directory name.

### #91 — Analysis: run one post-mortem end to end on real runs

**The issue claims:** `templates/post-mortem.yaml` declares everything the run needs; the runner knows nothing about post-mortems; it has never been executed; three named runs sit on disk with a spread of present/absent artifacts.

**True at HEAD.**
- The template is byte-identical to the version the issue describes: `md5 templates/post-mortem.yaml` is `15da2dfc2f1c4e991cb78e389f9d2b6d`, equal to `git show 259ed42:templates/post-mortem.yaml | md5`, and `git log 259ed42..HEAD -- templates/post-mortem.yaml` is empty.
- It declares `ask:` (`:83`), four agents `cost`/`spec`/`friction`/`reviewer` (`:121`, `:170`, `:216`, `:258`), `supervisor_system_prompt` (`:19`), 8 DoD criteria (`:106-113`) and `attester: "reviewer"` (`:17`).
- The runner knows nothing: `rg -i post-mortem src/` exits 1, and `SessionSchema` is a `z.strictObject` with no `role` key (`src/contracts/session-schema.ts:53-85`).
- It has never been executed: no `findings-summary.md` exists anywhere in the tree, and no `session.yaml` declares `id: post-mortem`.
- The three runs match the stated spread: `04-inspector-server` spans=yes scorecard=no, `r1-fixes` spans=no scorecard=yes, `jev-c2-closeout` spans=no scorecard=no.
- The finalize-gate citation holds: `parseCriteriaBlock` is at `src/contracts/criteria.ts:23`, consumed at `src/peer/peer-harness.ts:97,198`.
- The template still parses under the guardrails suite, which globs `templates/**/*.yaml` (`test/integration/guardrails.test.ts:24`): `bunx vitest run test/integration/guardrails.test.ts` → 82 passed, including "templates/post-mortem.yaml parses with a non-empty DoD and no placeholder model".

**Stale at HEAD.**
- "20 such dirs exist in total" → 29 directories named `run-details/` exist on disk (`find . -type d -name run-details`, excluding `node_modules`).
- "which is the majority case on disk" — `spans.jsonl` is absent in 12 of 29 run dirs (41%); it is present in 17. It is not a majority case now. The requirement that the post-mortem tolerate absent artifacts still stands; only the frequency wording is wrong.
- "replace the `REPLACE/` placeholders" — `templates/post-mortem.yaml` contains no `REPLACE/` token. Only the prose line `REPLACE with the run directories…` at `:89`. The `REPLACE/` token belongs to `templates/review-and-improve-code.yaml:37`.
- "`contextFiles` is inert (`src/peer/peer-harness.ts` drops it before the model call)" — `src/peer/peer-harness.ts` no longer mentions `contextFiles` at all. The field survives only in `src/contracts/a2a-schema.ts:64`, `src/pi/extension.ts:462,470` and `src/control/control-plane.ts:12`. The behaviour claim is unchanged; the citation no longer resolves.

**What the body needs.** "29" instead of "20"; delete "which is the majority case on disk" (or replace with "12 of 29 lack `spans.jsonl`"); change the work item to "replace the prose `REPLACE` line at `templates/post-mortem.yaml:89`"; move the `contextFiles` citation to `src/pi/extension.ts:462`/`src/contracts/a2a-schema.ts:64`. No DoD change.

### #94 — Analysis: document the task type and its template

**The issue claims:** `templates/post-mortem.yaml` exists and is undocumented; it is missing from both template lists, which also omit four other templates and disagree with each other; `GLOSSARY.md` has 37 entries with none for the post-mortem vocabulary; there is no `role: analysis` and no analysis module.

**True at HEAD.**
- `templates/post-mortem.yaml` is the only file in the tree naming a post-mortem: `rg -l -i 'post-mortem|postmortem' . --glob '!node_modules' --glob '!.git'` returns only `./templates/post-mortem.yaml`.
- It is in neither list: `README.md:206` §Templates (list at `:208-214`) and `docs/agent-config-guide.md:607` §11 Templates (list at `:609-621`).
- The same two lists also omit `templates/tdd-build.yaml`, `templates/free-research.yaml`, `templates/spec-plan-adversarial.yaml` and `templates/task-optimize-8/session.yaml`.
- No `role` and no analysis module: `SessionSchema` is a `z.strictObject` (`src/contracts/session-schema.ts:53-85`), and `ede7235` ("Revert runner changes; post-mortem is an ordinary task") deleted `src/supervisor/analysis-{types,targets,prompts,finalization}.ts` and `write-findings-summary.ts`.
- `GLOSSARY.md` has no entry for _post-mortem_, _analysis task_, _analyst_ or _run directory_. It has only _Task_ for the directory itself, and _Ask directory_ as a second name for the same thing (removed since, see #94).

**Stale at HEAD.**
- "`docs/agent-config-guide.md:528-546` (§11)" — §11 is at `:607-621`. Line 528 is inside §10.
- "Those two lists also … disagree with each other." They carry the same seven templates in the same order. The only difference is one description: README says `templates/session.yaml` is "master, every field commented" (`README.md:208`) where the guide says it "does not show every field: `wall_clock_ms` is omitted" (`docs/agent-config-guide.md:609-610`). `rg wall_clock_ms templates/session.yaml` exits 1, so the guide is right. The "disagree" claim is an overstatement of a single description conflict.
- "`GLOSSARY.md` — 37 entries" — `rg -c '^\*\*[^*]+\*\*:' GLOSSARY.md` → 32, and `git show 259ed42:GLOSSARY.md` also counts 32, so the number was never 37 at this commit or at filing.
- "Every file in `ls templates/` appears in both lists" — `ls templates/` includes the `task-optimize-8` directory, not only YAML files, and the enforced glob is `templates/**/*.yaml` (`test/integration/guardrails.test.ts:24`). The criterion as worded is ambiguous.
- "It declares no quality skill" — no skill concept exists in the schema; the sentence has no referent.

**What the body needs.** `:528-546` → `:607-621`; delete "they disagree with each other" or narrow it to the `session.yaml` description; "37" → "32"; reword AC1 to "every `templates/**/*.yaml` appears in both lists"; drop the "quality skill" clause; add that the post-mortem document is a supervisor-written artifact, so the "where it is written" line belongs in `docs/agent-config-guide.md` §7 "Run artifacts" (`:430-446`), not §11.

### #41 — No peer can open a prompt (peer-to-peer arm is unreachable)

**The issue claims:** `PeerMessaging.sendPrompt` is reachable only from the supervisor's `send_prompt` tool; a peer's pi session has no tool that writes to the bus, so the peer-to-peer `PROMPT` arm can never start.

**True at HEAD.**
- `sendPrompt` is defined at `src/runtime/peer-messaging.ts:39`, wrapped at `src/runtime/runtime.ts:517` → `:524`, and has exactly one production caller: `src/pi/extension.ts:509`, inside the `send_prompt` tool, with `from` hardcoded to `"supervisor"`.
- The peer tool set contains nothing that writes a `PROMPT`: `toolsForPermissions` returns only `read`, `grep`, `ls`, `find`, `web_fetch`, `edit`, `write`, `bash` (`src/peer/peer-config.ts:88-93`), and the peer factories are `permissionGate`, `toolCallLogger`, `changeNotifier`, `fileLock`, `webTool` (`src/peer/peer-main.ts:166-170`).
- `src/pi/extension.ts` is loaded by path and imported by nothing (`src/pi/extension.ts:1-6`), so the sole caller is supervisor-side.
- Inbound `PROMPT` frames are only handed to `peerMessaging.onPrompt` (`src/runtime/runtime.ts:1232-1233`) and are never re-emitted, so the wire format permitting `PROMPT` (`src/contracts/a2a-schema.ts:69`) does not make the arm reachable.
- The gap is a documented, deliberate deferral, not a missed bug: `README.md:17` ("the protocol also carries peer-to-peer prompts, though only the supervisor opens them today"), `docs/temp-handoffs/01-architecture-handoff.md:151`, `docs/landscape-and-positioning.md:11`, `docs/trace-semantics-oracle.md:100`, `docs/temp-handoffs/03-verification-handoff.md:90`.
  **Since this audit** (2026-10-29): the deferral was recorded as `docs/adr/0002-peer-to-peer-prompts-deferred.md`, and those notes now say not implemented and not planned instead of "designed but not reachable". The quotes above are the wording at audit time.
- The symmetric arm landed rather than being deleted: #40 ("No peer ever asks for a file lock") is CLOSED COMPLETED (2026-10-17T19:57:51Z) and `src/peer/file-lock.ts` is live.

**Stale at HEAD.**
- "`src/runtime/peer-messaging.ts:41`" → `:39`; "`src/pi/extension.ts:381`" → `:509`.
- "Found in the 2026-10-17 code-health audit (finding 19): `docs/audit-code-health-2026-10-17.md`" — that file was deleted in `1dd4e6e` ("ground every claim in the code, drop two superseded docs"). The citation no longer resolves.
- "delete the arm together with the file-lock issue's cleanup (finding 18)" — #40 shipped, so that pairing is gone. The remaining choice is implement the peer messaging tool plus a runtime relay, or delete the `PROMPT` arm outright.
- One stale renderer promised the mesh: `docs/architecture-diagram-alternatives/d2-supervision.d2:56` drew "peer↔peer PROMPT / RESPONSE (direct A2A — the supervisor is not in the loop)". The alternative-renderer docs are not canonical, but the contradiction remained. **Fixed since this audit** (`c6c0fad`): the edge is dashed and labelled "designed, not implemented; issue #41", the diagram's stale `.mypi/<task>/run-details/` path was corrected to `<taskDir>/<task>/run-details/`, and both renders were regenerated. The other 19 labels in that file were checked and are accurate.

**What the body needs.** Fix the two line numbers; replace the deleted audit-doc reference with a pointer to `docs/temp-handoffs/01-architecture-handoff.md:151` or the audit commit `1dd4e6e^`; note that #40 shipped so the symmetric "delete" option is no longer available and precedent favours implementing.

### #10 — Run-quality feedback loop: turn past-run mistakes into measurable improvements

**The issue claims:** two pillars — C measurement/feedback and B unattended long-horizon robustness — plus a five-class taxonomy, a corpus design, and a near-term goal of "output quality first, speed second".

**True at HEAD.**
- C1 shipped: `buildScorecard` (`src/scorecard/scorecard.ts:116`), `recordScorecard` (`src/scorecard/record.ts:96`), the finalize-time write (`src/runtime/runtime.ts:693-699`), default-on flag (`src/contracts/session-schema.ts:76`), documented at `docs/agent-config-guide.md:102`.
- C2 shipped as code, never exercised: `aggregate` (`src/scorecard/aggregate.ts:28`), `collect`/`readOptIn` (`src/scorecard/collector.ts:218`/`:171`), `writeTrends` (`src/scorecard/trends.ts`), CLI scripts `collect`/`trends`/`improvements` (`package.json:14-16`). `quality/trends.md` does not exist.
- C3 partial: `classifyMistakes` covers M1–M3 (`src/scorecard/mistakes.ts:26`); M4/M5 are advisories (`src/scorecard/advisories.ts`), and M5 deliberately does not check model evidence ("It does NOT check model _evidence_ — that needs the cross-run probe corpus (#19)", `src/scorecard/advisories.ts:5-7`).
- C4 partial: tracking exists (`src/scorecard/improvements.ts:23,44`), proposing does not — records are hand-authored ("Records live in a hand-authored JSONL file", `src/scorecard/improvements.ts:12`) and the proposer has never run (#91).
- C5 shipped as code, never exercised: `measureImprovement`/`renderImprovements` exist; no `quality/improvements.jsonl` exists, so nothing has been measured.
- Pillar B shipped: `markStalled` emits `AGENT_STALLED` and is notify-only (`src/runtime/runtime.ts:890-899`); the empty-turn watchdog exists (`src/supervisor/empty-turn.ts`); budget-boundary stop and run-level resume exist (`src/runtime/run-state.ts`, `src/runtime/runtime.ts:317`).
- Every child is closed: #12, #13, #14, #15, #16, #17, #18, #19 are all CLOSED. The only open work is #90/#91/#94.

**Stale at HEAD.**
- ".mypi directories" — the loop corpus text and the README now use `taskDirs: [mypi-tasks]` (`README.md:58`, `:108`). `.mypi/` survives only inside `docs/architecture-diagram-alternatives/`.
- "opt-in per repo via a session flag" — recording is now per-run and default-on (`record_scorecard` default `true`, `src/contracts/session-schema.ts:76`), with file-based opt-in only for cross-project collection (`quality/opt-in.json`, currently `[]`).

**Does the loop close end to end? No.** `record_scorecard` → `run-details/scorecard.json` → `appendLedgerLine(<workspaceRoot>/quality/ledger.jsonl)` works and has produced three lines on disk, but all three are `outcome: success`, `dod: met`, zero mistakes. Nothing writes an `ImprovementRecord`, so `measureImprovement` has no input and `quality/improvements.md`/`quality/trends.md` are never generated. With three zero-mistake cards, any record with `beforeCount ≤ 3` measures a 0.000 before-rate and reports `unchanged` until failing runs land. The ledger is gitignored (`.gitignore:17`), so a fresh clone carries no loop data.

**What the body needs.** Replace the `.mypi` layout paragraph; describe the default-on `record_scorecard` plus file-based collection opt-in; record that pillars B and C1–C3 are shipped and that the unbuilt leg is propose → measure, i.e. run the post-mortem (#91), land one `ImprovementRecord`, and show the rate move.

### Blocker graph

The real edges are `#91 → #90` and `#91 → #94`; the `#97 → #90` edge is dead.
- **#97 → #90: dead.** #97 is CLOSED COMPLETED and the append is live and default-on (`src/runtime/runtime.ts:693-699`, `src/contracts/session-schema.ts:76`), and `quality/ledger.jsonl` already holds three lines on disk.
- **#91 → #90: real.** `analysis` names an analysis run id, and no analysis run exists. Nothing can name one until #91 executes.
- **#91 → #94: real but over-broad.** It gates the acceptance criterion "A maintainer can create a working post-mortem session from the docs alone" and any sentence asserting where the document lands. It does not gate the list additions, the template descriptions, or the glossary entries — those are readable facts in `templates/post-mortem.yaml:106-113`, `:54`, `:5-7`, `:96-100`. #94 could be split into "document the template as declared" (doable now) and "document post-mortem behaviour" (gated).
- **#96 and #95 are not edges.** Both are CLOSED NOT_PLANNED, and both name the analysis E2E ticket as the surviving question: #96's close says "does a post-mortem actually run end to end on real run directories … is the E2E ticket", and #95's close says the durable measurement half "is … a measurement half that #90 already covers".

## Direction check

`docs/landscape-and-positioning.md:54-56` names this work as the next investment: "New direction: run-quality feedback loop … The next investment is not more orchestration; it is learning from past runs." `AGENTS.md:5` makes the issue tracker the source of truth. Recent history agrees: the last scorecard/loop commits are Oct 16–23, and everything since is doc-claim auditing (for example `205cb70`, `96135e4`, `1dd4e6e`) plus anti-slop work, so the front end is effectively frozen while claims are reconciled.

Against that direction:
- #90, #91 and #10 all advance the loop; #94 is documentation for it. None pulls against the direction.
- #41 pulls against it only in priority. `docs/landscape-and-positioning.md:11` already labels the peer mesh "designed but not reachable end to end yet", and `docs/temp-handoffs/01-architecture-handoff.md:151` lists it as a known deferral. The direction explicitly says the next investment is _not_ more orchestration, which is what implementing peer-to-peer prompts is. #41 is the one issue whose normative question ("implement or delete the arm") is an orchestration decision the direction argues against expanding.
- #10's body is the only one that conflicts with the tree, and only in its layout/opt-in paragraphs, not in its goal.

## Recommendations

| Issue | Action                       | Detail                                                                                                                                                                                                                                                                                  |
| ----- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #90   | Restate                      | Fix the three stale facts and AC1/AC4, name the id form, and drop #97 from "Blocked by". Keep `analysis`; keep blocked on #91 only.                                                                                                                                                     |
| #91   | Keep as-is, minus two counts | The DoD is intact and the template has not changed a byte. Correct "20" → 29 and delete the "majority case" clause, then land it.                                                                                                                                                       |
| #94   | Restate and split            | Unblock the list/glossary edits now; keep only the behavioural sentences behind #91. Fix `:528-546` → `:607-621`, the "disagree" claim, and "37" → "32".                                                                                                                                |
| #41   | Re-label, not close          | Keep `ready-for-human`; it is a keep-or-delete product decision, not a patch. Front-load the decision: implement the peer tool plus a relay, or delete the `PROMPT` arm. Fix the dead audit-doc citation first.                                                                         |
| #10   | Re-label and restate         | Remove `needs-triage` (spec #13 was written and closed; 11 children were created and closed). Restate narrower: drop pillars B and C1–C3 as shipped and scope it to closing the loop via #91, #90 and #94. Do not close: the epic's stated measurable end state was never demonstrated. |

Land order: #91 first (everything else in the loop references its output), then #90 and the unblocked half of #94, then the #94 behavioural half, with #41 decided separately.

## Claims that did not survive re-check

- A report placed `attester: "reviewer"` at `templates/post-mortem.yaml:12`. Counter-evidence: line 12 is blank; the key is at `:17`, between `agent_stop_threshold_percent: 85` (`:16`) and `supervisor_model` (`:18`).
- A report asserted the run-dir population was "10/20" at filing. Counter-evidence: not reproducible — `run-details/` is gitignored (`.gitignore:6`) and no tracked artifact records the on-disk count at `259ed42`. Only the HEAD number (12 of 29 lack `spans.jsonl`) is used above.
- A report listed model resolution as "PLAUSIBLE, unproven live". Not re-verified here either: the slugs are concrete and reused elsewhere, and `verify_models` defaults to `warn` (`src/contracts/session-schema.ts:69`), so nothing asserts resolution at load. Claim excluded from this note.
- Everything else the reports asserted about #90, #91, #94, #41 and #10 was re-run against HEAD and matched.
