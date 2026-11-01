# Batch: ticket intake → prepared manifests → serial runs

Design, then the review of it against HEAD (2026-11-01). Four readers examined separate slices of the
codebase and a fifth attacked their conclusions; every claim below carries a path:line or a command
result, and the ones that did not survive re-checking are marked as such.

Landed so far: steps 1–3 of §7 (`src/batch/{dod,manifest,preflight}.ts`, #178–#180) and step 6
(`recordDirs` + ignore rules, #184). The CLI itself does not exist yet: `rg -n "mypi-batch" src/ test/
justfile package.json` still finds nothing.

Supersedes the open questions in `docs/explorations/ticket-batch-automation.md`; sits on the two
prior reviews (`docs/temp-handoffs/04-triage-run-type-handoff.md`,
`docs/temp-handoffs/05-batch-ticket-loop-review-handoff.md`) and the two measured prompts in
`docs/explorations/triage-automation/`.

## 1. What this is

Two verbs over a batch of GitHub tickets. `prepare` turns a ticket into a verified Definition of
Done (DoD) plus a runnable `session.yaml`. `run` executes the accepted manifests one at a time,
records the outcome, and halts on the first failure. Neither verb changes the runtime, the
extension, or the manifest schema.

```
mypi-batch new <id> <ticket...>        # write batches/<id>/request.yaml
mypi-batch prepare <id> [--dry-run]    # triage -> verify -> comment -> label -> manifest
mypi-batch retemplate <id> <n> <kind>  # change the template before any run record exists
mypi-batch run <id>                    # serial; halts on first failure
```

## 2. Decided (D)

Revised marks: **←R5** means the 2026-11-01 review forced the change, with the finding number.
- **D1 — The batch lives outside the runtime.** No new run type, no new extension command, no schema
  field. A run cannot fetch its own ticket (the supervisor's 11 tools include no tracker tool), so a
  driver has to materialize the manifest either way.
- **D2 — Two lifetimes, two files.** `mypi-batch.yaml` (root, committed) is policy; `batches/<id>/request.yaml`
  is one batch. Neither is written by the tool.
- **D3 — `batches/<id>/` is the batch record.** `request.yaml`, `summary.md`, `summary.json`, `tickets/<n>/{report,claims,verdicts,manifest,run}.json|md`.
- **D4 — Paths ←R5.** Records: `batches/<id>/`. Generated manifests: `mypi-tasks/b-<batch>-t<n>/session.yaml`
  (flat, so `resolveSessionPath` finds them — `src/pi/session-path.ts:39-63`). `.gitignore` gets
  explicit lines: `batches/*/tickets/` and `mypi-tasks/b-*/`; neither is ignored today
  (`git check-ignore -v mypi-tasks/batch-1/session.yaml batches/b1/request.yaml` → no match).
  `mypi-multi-agent.yaml` gains an optional `recordDirs: ["batches"]`, and `classifyDirtyTree`
  exempts it exactly as it exempts `taskDirs` — otherwise the driver's own writes make the next
  `mypi-run` refuse (the guard is `src/pi/launch.ts:44-67`, call site `:138`; parsing is tolerant of
  the new key, `shared/parse-multi-agent-config.ts:20-34`).
- **D5 — `ready-for-agent` is applied only by `prepare`, and is not an idempotence key.** It already
  sits on #163–#169, so presence proves nothing; the batch record does.
- **D6 — Writeback is a comment, not the body ←R5.** The repo's own triage contract says the agent
  brief is a structured comment and "the original body and discussion are context"
  (`~/.agents/skills/triage/AGENT-BRIEF.md:5`). So `prepare` posts one marker comment
  (`<!-- mypi-batch:<id>:<n> -->`, AI disclaimer first per `~/.agents/skills/triage/SKILL.md:13-17`)
  holding the kind and the DoD, and never edits the body. The manifest is generated from the
  in-memory report, and `prepare` asserts the comment's criteria list equals the manifest's before
  the label goes on.
- **D7 — Re-prepare edits that comment by id.** No body write, so no lost-update window and no ETag
  dance. A second marker for the same batch+ticket means a prior partial write: repair it, do not
  duplicate.
- **D8 — Template choice is a kind, chosen at prepare.** One `kind_templates` table in policy, one
  default per batch; the triage agent returns `KIND: <one of policy.prepare.kinds>`, injected into
  the prompt from policy so renaming a template never edits the prompt. `retemplate` rewrites the
  override, the manifest, the comment and the record.
- **D9 — Only the triage agent can remove a ticket from the batch.** Its existing `run`/`inline`
  decision becomes `KIND: inline`: DoD comment written, no manifest, no label.
- **D10 — Refusals are reason codes.** `not-needed | outdated | blocked-decision | unverifiable |
  verifier-mismatch | dod-rejected | kind-invalid | template-missing | already-prepared |
  manifest-invalid | model-unavailable | startup-failed | timeout | batch-halted | blocked-by-failed`.
- **D11 — Acceptance is mechanical.** Every verifier row `match`; ≥1 criterion; kind resolves; the DoD
  is markdown-free after normalization (D20); `parseSessionConfig` accepts the manifest; each agent
  slug resolves. Only then are the comment and label written.
- **D12 — `run` is serial and halts on the first non-success.** Pre-launch faults
  (`manifest-invalid`, `model-unavailable`) halt before spending anything; `startup-failed` gets one
  retry, then halts; `timeout` and `failure` halt. Untouched tickets are recorded `batch-halted`.
- **D13 — No resume.** A halted batch is finished; the retry is a new batch. `run` refuses a batch
  that already has run records. `retemplate` is refused once any run record exists (frozen-run rule,
  `AGENTS.md:9`).
- **D14 — The driver owns the lifecycle ←R5.** `herdr workspace create --label mypi-<slug>` →
  `herdr pane run <pane> 'pi "/mypi-multi-agent <slug>"'`; the workspace is closed by the driver on
  success, failure and timeout. The `pane close` suffix from `justfile:131` is dead code for this
  path: a successful run never exits pi (`rg -n "process\.exit" src/pi/extension.ts src/runtime/` →
  none), so a finished batch otherwise leaves one idle workspace per ticket (`herdr workspace list`
  still shows `mypi-16-antislop-audit-n3` from a finished run).
- **D15 — "Decided" and "finished" are different signals ←R5.** `final.md` is written before teardown
  (`src/runtime/runtime.ts:814-840`, then `src/pi/extension.ts:300-303`), non-atomically
  (`src/artifacts/final-writer.ts:37-38`), and `abortSession` can still overwrite it with
  `status: aborted` (`src/control/abort.ts:40-49`). So: poll until the frontmatter is complete and
  stable across two reads _and_ its mtime is newer than run start; then wait for `.peer-*.json` to
  disappear (written by `cleanup()`, finalize-only, `src/runtime/runtime.ts:523-528`); only then
  close the workspace and record. `timeout` is its own code, because exit 3 never occurs and "no
  artifact" cannot separate crash, hang, refusal and preflight rejection.
- **D16 — Nothing is landed or merged.** Branches are left for `just land`.
- **D17 — `failing_terms` in `final.md` is optional ←R5.** Failing terms are already logged as
  `{"event":"gate-rejected","term":...}` per term (`src/runtime/finalize-gate.ts:157-168`), and
  `mypi-tasks/post-mortem-01/run-details/conversation.jsonl` carries one. v1 reads that; adding the
  frontmatter field later is a convenience, not a prerequisite.
- **D18 — Dependency ordering is out of v1.** `gh issue view --json blockedBy` works
  (`{"blockedBy":{"nodes":[],"totalCount":0}}` on #163) and topo-sorts a serial batch for free.
- **D19 — The batch config gets `docs/batch-guide.md`;** `docs/agent-config-guide.md` stays strictly
  about `session.yaml`.
- **D20 — The DoD is stored markdown-free ←R5.** The gate folds only a label prefix, backticks,
  quotes, dashes and whitespace (`src/supervisor/finalization.ts:66-85`); measured:
  `- [ ] X` vs `X` → 1 mismatch, `**X**` vs `X` → 1, a markdown link vs its own text → 1. A markdown-bearing DoD
  therefore fails `criteria` after the whole run is paid for. `prepare` normalizes to plain text,
  refuses residuals (`* _ [ ] #`), emits YAML with a serializer, re-parses, and self-checks with
  `criteriaMismatches(=<manifest DoD>, manifest DoD)` — verified true on the round-trip probe (F8).
- **D21 — Both verbs preflight the models.** `pi --list-models <provider/model>` exits 0 with matches
  (verified). `prepare` refuses to write a comment for a manifest whose slugs do not resolve; `run`
  refuses before launch.
- **D22 — Code layout.** `src/batch/*` (typechecked: `tsconfig.json:16`) with tests in `test/unit` +
  `test/integration` (vitest includes only `test/**`, `vitest.config.ts:5`), one `package.json` script
  plus one `just` alias. `scripts/batch/` would be linted but never typechecked.

## 3. Rejected (O)

- **O1 — A new run type / batch run.** Needs a driver anyway (D1).
- **O2 — One config for a whole batch.** The gate compares verdicts to one manifest's DoD array.
- **O3 — `ready-for-task` as a second entry label.** Two predicates, no owner.
- **O4 — A `task_type` field in `session.yaml`.** The type's only job is template selection at
  generation time; `SessionConfigSchema` is strict and `session.id` is read nowhere in `src/` anyway.
- **O5 — `pi -p "/mypi-multi-agent <task>"` as the executor.** Structurally dead: the handler returns
  without awaiting `sendUserMessage` (`src/pi/extension.ts:265-271`), so print mode disposes the
  session, `session_shutdown` fires, and the extension aborts the run (`:310-315`). Confirmed
  independently: a probe command that calls `sendUserMessage` exits in 0.37 s with no output.
- **O6 — RPC mode.** Unexplored and unnecessary once D14 holds.
- **O7 — Auto-landing.** `main` is protected.
- **O8 — ETag CAS on the body.** Moot under D6.

## 4. Verified (F)

- **F1** — Slash commands dispatch headlessly (`pi -p "/mypi-multi-agent --init"` created the config
  and starter task, exit 0) — but see O5 for what that does not imply.
- **F2** — `--tools read,bash,grep,find,ls` replaces the whole tool selection, so the operator's
  `defaultTools: ["+codemode"]` is excluded.
- **F3** — `--mode json` exposes `usage.cost.total`; one live call measured $0.002.
- **F4** — `herdr workspace close` kills the pane's processes: `sleep 317` in `w24:p1` was gone after
  close (`pgrep` empty, workspace absent from `herdr workspace list`).
- **F5** — `herdr workspace create` and `herdr workspace list` emit JSON by default; `pane list` and
  `pane process-info` reject `--json` (critic re-check). Orphan enumeration is cheap; pane-level
  probes are not.
- **F6** — `templates/code-fix.yaml` and `templates/review-and-improve-code.yaml` both pass
  `parseSessionConfig`, but the latter carries three `REPLACE/with-a-real-model` slugs with
  `verify_models: strict`, so it is validating-but-unlaunchable (`src/pi/model-preflight.ts:39-46`).
- **F7** — The repo has no issue templates and no labelling workflow; `issueType` is `null`
  repo-wide and `GET /issues/types` is 404. Labels are hand-applied.
- **F8** — A real ticket → manifest → gate round trip works: the DoD survived byte-identical and
  `criteriaSatisfied(verdicts, manifest DoD)` returned true.
- **F9** — 35 task dirs exist, none named `batch-*`; `resolveSessionPath(cwd)` throws on the
  ambiguity and does not sanitize a name (`resolveSessionPath(cwd, "../mypi-tasks/17-lock-protocol")`
  resolves), so slugs must be charset-validated.
- **F10** — `just prep` links only the root `node_modules`; `web/node_modules` exists in the main
  checkout but is gitignored, and `check` ends with `test:web`, so a prep'd worktree cannot pass
  `bun run check` (live: `Cannot find package 'markdown-it'`).
- **F11** — Startup failures write nothing: `startRun`'s catch notifies and returns without an
  artifact (`src/pi/extension.ts:250-258`), and `loadSession` failures return earlier still.
- **F12** — The A2A socket is per task dir (`src/bus/socket-server.ts:16-22`) and refuses a second
  live server (`:48-53`), which is the executor's real collision guard.
- **F13** — `run-state.json` is written after `final.md` (`src/runtime/runtime.ts:839` vs `:818`).
- **F14** — `biome` checks YAML under `**` (honouring gitignore), and no guard test reads
  `batches/`; ADR index is enforced with `0004-` next (`test/integration/guardrails.test.ts:230-236`,
  `docs/adr/README.md:10`).

## 5. Review findings (W)

Ranked by cost. Resolved by the decision in brackets; unresolved ones are in §6.
- **W1 — A markdown DoD costs a full run** (measured mismatches, D20).
- **W2 — `final.md` is "decided", not "finished"; non-atomic; abort can overwrite it** (D15).
- **W3 — A successful run leaks a live workspace and an idle `pi`** (D14; visible today as
  `mypi-16-antislop-audit-n3`).
- **W4 — No runtime timeout exists.** `wall_clock_ms` is display-only
  (`src/pi/extension.ts:434-437`); a dead peer only notifies (`src/runtime/runtime.ts:1085-1099`), and
  nothing self-finalizes. The driver's own bound is the only one (D15).
- **W5 — A prep'd worktree cannot be green** (F10). Driver links `web/node_modules` as well, or the
  `validation` term fails for an infrastructure reason and is misrecorded as work failure.
- **W6 — Startup failures are silent and indistinguishable** (F11), so "halt on no artifact" would
  halt on a typo. Pre-launch preflight (D21) plus one retry (D12) is the mitigation; a residual class
  remains (§6 Q1).
- **W7 — Templates are unlaunchable as authored** (F6). Ship a `templates/batch-code-fix.yaml` with
  real slugs (2 devs + reviewer + supervisor) rather than reusing the placeholder template.
- **W8 — The body is the wrong surface for the DoD** (D6), and the body write had no CAS (O8).
- **W9 — Slug and task-dir hazards:** unsanitized names (F9), stale worktrees reused by `just prep`
  (`justfile:105-108`), so the slug carries the batch id: `b-<batch>-t<n>`.
- **W10 — Generated manifests are YAML inside `bun run lint`** (F14). Keep them gitignored so biome
  skips them, and never let `biome check --write` touch a record.
- **W11 — Scorecard and ledger fan out per worktree** (`src/runtime/runtime.ts:829`), so a batch
  produces N gitignored ledgers. `record_scorecard` stays on (its `scorecard.json` is the cheapest
  non-gating signal) and the driver copies `scorecard.json` into the batch record.
- **W12 — Re-running the same task dir commingles artifacts** (logs append, `final.md` overwrites).
  Each attempt gets a fresh dir; `run` refuses a dir that already has `run-details/final.md`.
- **W13 — The manifest cannot record provenance.** `strictObject` rejects extra keys and `session.id`
  is unused; provenance lives in the directory name and the batch record.
- **W14 — `classifyDirtyTree` is not on the batch path at all**, and `batches/` is outside `taskDirs`,
  so without D4 the driver's writes would refuse the next `mypi-run` in the main checkout.

## 6. Unresolved (Q)

- **Q1** — Whether a _transient_ provider failure ever ends with `final.md` absent while the run was
  fine otherwise. Consequence: D12's halt rule could end a batch on a flake. Cheapest test: one ticket
  with a bogus API key, one with a bad model slug, then `ls mypi-tasks/<slug>/run-details/` — F11
  predicts both empty, which is why D21 refuses before launch instead of classifying after.
- **Q2** — Whether `.peer-*.json` disappearance is always observable before the workspace close
  (an aborted run keeps them, `src/runtime/runtime.ts:524-527`). If not, fall back to `final.md`
  stability plus a fixed grace.
- **Q3** — Non-empty `blockedBy` payload shape; no issue in the repo has a dependency edge.
- **Q4** — Which two kinds ship first. Proposal: `code-fix`, `analysis`; `tdd` when a batch wants it.
- **Q5** — Whether `herdr agent wait` exists as a CLI verb and is a better completion signal than
  file polling. Optional (§5 W2 is already solvable without it).

## 7. Implementation plan

Order matters: each step is independently checkable and nothing live is spent until the last.

| #   | Work                                                                                                                                 | Where                                                    | Check                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | DoD normalization + self-check (`normalizeDoD`)                                                                                      | `src/batch/dod.ts`                                       | `test/unit/batch-dod.test.ts` — the thirteen measured marker cases pass, a reworded criterion still fails                             |
| 2   | Manifest build: template load, ask substitution, serialize → re-parse → `parseSessionConfig`                                         | `src/batch/manifest.ts`                                  | `test/unit/batch-manifest.test.ts` on `templates/code-fix.yaml` + a hand-made 2-dev template                                          |
| 3   | Model preflight wrapper around `pi --list-models` (injectable exec)                                                                  | `src/batch/preflight.ts`                                 | unit test with a recorded output; refuses an unknown slug                                                                             |
| 4   | Tracker adapter: view, marker-comment upsert, label add/remove, refusal comment                                                      | `src/batch/tracker.ts`                                   | `test/unit/batch-tracker.test.ts` against recorded `gh` JSON                                                                          |
| 5   | `prepare` + `new` + `retemplate` + records                                                                                           | `src/batch/prepare.ts`, `cli.ts`                         | `mypi-batch prepare <id> --dry-run` prints a table; no writes                                                                         |
| 6   | `recordDirs` config field + guard exemption                                                                                          | `shared/parse-multi-agent-config.ts`, `src/pi/launch.ts` | existing `launch` tests extended; `batches/` dirty no longer refuses                                                                  |
| 7   | Executor: worktree via `just prep`, launch, poll, timeout, close, record                                                             | `src/batch/executor.ts`                                  | `test/integration/batch-executor.test.ts` with a fake `HerdrClient` (the interface already exists, `src/herdr/herdr-client.ts:10-28`) |
| 8   | Docs: `docs/batch-guide.md` linked from README, ADR `0004-batch-driver-outside-the-runtime.md`, glossary `Batch` / `Kind` / `Ticket` | `docs/`, `GLOSSARY.md`                                   | `bun run check` (link + ADR index + citation guards)                                                                                  |
| 9   | One live smoke: one ticket, `templates/batch-code-fix.yaml`, cheapest two slugs                                                      | manual                                                   | `batches/<id>/summary.md` shows `success` and the branch exists                                                                       |

Landed: 1–3 (#178–#180) and 6 (#184). Next: 4, 5, 7, 8, 9.

Environment obligations: `main` is protected (`just land` only); a finished run is frozen, so the
driver copies artifacts out and never writes under `run-details/`; the batch template is the only new
`templates/` file; `mypi-batch.yaml` must be listed in `docs/batch-guide.md` and its keys documented
there.

## 8. Verdict

`prepare` is implementable as specified once D20/D21 are in place: it is a pure function over `gh`
plus the schema, and its failure mode is a refused write.

`run` was not implementable as first written — it assumed a completion signal the runtime does not
emit and a teardown no code performs. With D14/D15 (driver owns launch, close, timeout, and the
decided-vs-finished split) and D12's pre-launch gate, it is.
