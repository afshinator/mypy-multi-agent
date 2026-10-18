# Does Pi Durable fit `multi-agent` (mypi)?

Research pass, 2026-10-16. Anchor: the Pi Durable RFC and the vendor source at tag `v1.0.0`
(2026-10-01), plus the published npm package as it stands today (1.3.0, 2026-10-15).
All URLs fetched live; status codes and fetch times in [Sources](#7-sources).
Nothing in this file is inferred from a secondary write-up.

**Re-verified 2026-10-17** against this repo at `1dd4e6e`, and against the vendor: `@earendil-works/pi-durable` is still `1.3.0` (latest, published 2026-10-15T19:13:35Z, 16 versions), so §1-§2 are unchanged. This repo's own size moved, so every count here was re-measured, and line citations into `src/` were replaced with symbol names — they rot on every edit, and five `runtime.ts` edits landed since the first pass.

**Headline:** Pi Durable is a *harness* (storage + agent loop + task scheduler). `multi-agent` is a
*supervisor and control plane* whose peers are pi coding-agent processes in herdr panes. The two are
adjacent, not overlapping, and the overlap sits on the side of the repo that the positioning doc
calls the strategic fork. Verdict in [§5](#5-verdict).

---

## 1. What Pi Durable is

- **F1 — A durable agent harness, deliberately not a replacement for the pi coding agent.** "Pi Durable
  is that harness. It does not replace the Pi coding agent. It is a framework for building any agentic
  application, coding agents included." (`pi-durable` post; `pi-1-0` post repeats it: "a new
  experimental package", "Pi must become more durable"). Its unit is a *conversation*: an LLM plus
  settings plus the tools it can call, running in an execution environment
  (README-v1.0.0.md:76-88).
- **F2 — The durability model is commit-before-observe plus per-step task checkpoints.** "Conversations,
  model turns, tool calls, and your own state are committed to storage before anything is shown."
  (README-v1.0.0.md:5). "every step of a run is a task that stores a checkpoint before it moves on"
  (post). Recovery is: reopen the storage, find unfinished tasks, continue from the last checkpoint.
- **F3 — Crash semantics per artifact type.** A cut-off model request is re-sent and the partial answer
  stays marked aborted; a cut-off tool call re-runs only when declared `replay: "safe"`, otherwise the
  model receives an `interrupted` result with the output committed so far (post; README-v1.0.0.md:166).
  A tool's intent is committed *before* `execute()` runs (README-v1.0.0.md:166).
- **F4 — Exactly-once client retries.** "A retried submission with the same `requestId` returns the
  existing submission instead of submitting twice" (README-v1.0.0.md:113-121); `harness.submission(id)`
  reacquires a submission after a restart (harness.ts:257).
- **F5 — Conversations fork and carry their own agent.** A fork sees the parent's entries up to an
  entry id without copying them, and keeps the parent's agent as of that entry; each conversation stores
  model, thinking level, extension/tool selection, instructions and `cwd`
  (post; README-v1.0.0.md:390-402 and Per-Conversation Agent).
- **F6 — Extensions are named bundles of prompt sections, tools, hooks, wraps and tasks**, installed in
  a process-owned registry that can be replaced while conversations run; conversations store extension
  *names*, never code, so a restart picks up whatever the new process installs (post; README-v1.0.0.md
  §Extensions, §Reload).
- **F7 — Tasks form an ownership tree with bottom-up abort.** A task can own child tasks and wait on
  them (`allSettled` / `failFast`); aborting runs bottom-up so each task cleans up its own effects
  (post; README-v1.0.0.md §Child Tasks). A subagent is "a conversation owned by the tool call that
  started it" (post) — there are no built-in subagents (post).
- **F8 — Storage is pluggable and portable.** Memory, SQLite, JSONL and a Cloudflare Durable Object
  SQLite adapter (README-v1.0.0.md §Storage). The SQLite and JSONL cores contain no `node:` imports —
  enforced by a test that walks the import graph (test/storage-runtime-boundary.test.ts).
- **F9 — Multi-client by construction.** `viewState()` is a replicated Chord state updated after every
  commit; `watch()` delivers the exact commit operations; `watchEvents()` re-shapes them into
  coding-agent-style events (post; README-v1.0.0.md §Watching a Conversation). "any number of clients
  can attach to any conversation" (post).
- **F10 — Compaction, reset/handoff and app-state documents are all durable tasks.** Background
  compaction with a blocking threshold and a one-shot retry after a context overflow; `reset(note)` /
  `control: { handoff }` starts a new context while older entries stay searchable; documents are typed
  JSON committed in the same transaction as the transcript (post; README-v1.0.0.md §Compaction,
  §Reset and Handoff, §Your Own State).
- **F11 — One process owns a storage at a time.** "One process owns a storage at a time; there is no
  cross-process locking." (README-v1.0.0.md:527). The vendor's own multi-process story is one worker
  process per session directory behind a `proper-lockfile` lock (coding-agent
  `experimental/session-worker.ts:517-527`, `experimental/durable/sessions.ts`), coordinated over unix
  sockets (`experimental/coordinator.ts`).

## 2. API surface and hard facts

| Fact | Value | Source |
|---|---|---|
| Package | `@earendil-works/pi-durable` | package.json (v1.0.0); npm registry |
| Description | "Durable conversation, task, and document runtime for Pi" | package.json:4; npm 1.3.0 metadata |
| Published? | Yes. Latest `1.3.0`, published 2026-10-15T19:13:35Z. First version `0.0.1` 2026-09-19T18:11:47Z. 16 versions. | npm registry `dist-tags`, `time` |
| dist-tags | `{latest: 1.3.0}` only. No `next`/`experimental`/prerelease tag. `deprecated: null`. | npm registry |
| Experimental status | A README banner, not registry metadata: "**Experimental.** The API changes without notice between releases." | README-v1.0.0.md:3 (identical line in the 1.3.0 tarball README) |
| License | MIT (repo root and package) | package.json; `pi-1-0` post ("Both are MIT licensed") |
| Engines | `node >= 22.19.0` | package.json; npm 1.3.0 metadata |
| Runtime targets | Node 22 in CI (`npm test`, `ci.yml` `setup-node` 22); portable SQLite/JSONL cores with no `node:` imports; Cloudflare DO adapter; Node execution env. Bun support is a *vendor claim* (README:527, post) — no Bun job in `ci.yml`. | ci.yml; storage-runtime-boundary.test.ts; README-v1.0.0.md:527 |
| Dependencies (1.3.0) | `@earendil-works/chord` 1.3.0, `@earendil-works/pi-ai` 1.3.0, `@earendil-works/pi-codemode` 1.3.0, `@silvia-odwyer/photon` 0.3.3, `diff` 8.0.4, `typebox` 1.3.27 | npm 1.3.0 metadata |
| Exports map (1.3.0) | 17 subpaths: `.`, `./env`, `./env/node`, `./tools`, `./testing`, `./codemode`, `./tool-search`, `./images`, `./images/node`, `./images/cloudflare`, `./storage/{memory,jsonl,jsonl/node,sqlite,sqlite/node,sqlite/cloudflare}`, `./package.json` | npm 1.3.0 metadata |
| Size of source @ v1.0.0 | 17,662 lines / 60 files (669,654 B) under `packages/durable/src`; 15,483 excluding `src/testing` (2,179 lines); storage backends 2,926 lines (memory 810, sqlite 1,251, jsonl 865). The post's "about 15,000 lines … storage backends alone are 3,000 lines" checks out. | measured from the v1.0.0 tree (`git/trees?recursive=1` + raw fetch, `wc -l`) |
| Tests | 42 `*.test.ts` (955,076 B) plus 41 support files; `npm test` = `vitest --run && PI_DURABLE_DOCUMENT_RETENTION_MS=0 vitest --run` (1.3.0) | v1.0.0 tree listing; npm 1.3.0 scripts |
| Normative spec | `packages/durable/docs/spec.md`, 4,601 lines, "Pico5 is a durable, extensible agent harness. This document is normative." | spec.md:1 |
| API churn, measured | v1.0.0 (2026-10-01) → 1.3.0 (2026-10-15): 5 new export subpaths (`/images`, `/images/node`, `/images/cloudflare`, `/codemode`, `/tool-search`), 2 new runtime deps (`pi-codemode`, photon), new `structuredOutput` tool channel, new `pi.provider` document. README diff over the tag range: 252 diff lines. | npm 1.3.0 metadata vs v1.0.0 package.json; README diff |

Exported API surface that matters for the fit (`packages/durable/src/index.ts`, v1.0.0):

- **Harness** — `Harness.open(storage, {models, registry, env, settings}, context)`; `root`,
  `createConversation`, `conversation`, `resume(): void` (harness.ts:236), `openTasks`:232,
  `inspect`:247, `submission`:257, `abortSubmission`:261, `abortTask`:269, `waitForIdle`:278,
  `usage`:284, `taskGraph`:296, `watchTaskGraph`:300.
- **Conversation** — `configure`:95, `submit`:99, `compact`:103, `reset`:109, `context`:122,
  `entries`:126, `fork`:140, `abort`:144 (with `{background: true}`), `waitForIdle`:149,
  `viewState`:154, `watch`:158.
- **Definitions** — `defineExtension`, `defineTool`, `hook`, `section`, `wrapTool`, `wrapSection`
  (index.ts:22), `defineDoc`, `defineDocFamily`, `defineTask` (tasks.ts:3), plus built-in
  `GenerationTask`, `ToolTask`, `CompactionTask`.
- **Tool semantics** — `replay: "safe"` opt-in for crash re-run (README-v1.0.0.md:166), three result
  channels (`output` for the model, `structuredOutput` for programs, `details` for UIs), `callers`
  (`model` / `tools` / both), `deferred: true` + `control.addTools`, nested calls via
  `api.executeTool()` with its own `NestedCallDoc` journal (1.3.0 README §Calling tools from tools).
- **Storage** — `MemoryStorage`, `openNodeSqliteStorage(path)` (storage/sqlite/node.ts:205,
  `node:sqlite` `DatabaseSync`, node.ts:3-4), `openNodeJsonlStorage(dir, context)`
  (storage/jsonl/node.ts:6), Cloudflare DO adapter; conformance suite
  `registerStorageConformance` (testing/).
- **Environments** — `ExecutionEnv` (env/index.ts:174), `NodeExecutionEnv` (env/node.ts:437),
  Cloudflare/remote implementable; `env` is a per-call factory keyed on the conversation's `cwd`.
- **Hooks** — `GenerationTask` (`beforeRequest`, `afterResponse`, `onYield`, `afterTools`) and
  `ToolTask` (`beforeTool` block/rewrite, `afterTool`); hooks re-run after a crash, so decisions must be
  memoized with `api.memo` (post; README-v1.0.0.md §Hooks).
- **Persistence keys** — `requestId` (exactly-once submission), persisted per-conversation provider
  `sessionId` (`pi.provider`), `abandonOnRestart: true` for tasks that must not be resumed.

## 3. Overlap map

`multi-agent` today, by the file that owns it (src is 7,665 lines / 69 files; tests 84 files / 12,352 lines):

| Pi Durable capability | What this repo has already | Verdict |
|---|---|---|
| Durable transcript + resume of a conversation | `ConversationLog` append-only JSONL (src/logging/conversation-log.ts) for audit; peer pi sessions are `SessionManager.inMemory()` (src/peer/peer-main.ts) so context is lost on crash | **Duplicate at the wrong layer.** Repo persists the *record* (E1) but not the *resumable context*; `buildResumeBriefing` itself lists "peer conversation context (in-memory, lost)" as unrecoverable |
| Per-step task checkpoint + crash continuation | Run-state snapshot only at work-order boundaries (`writeRunStateSnapshot`, src/runtime/runtime.ts, called at dispatch and when a peer reports); no per-tool-call checkpoint | **Complementary** — this is the repo's real gap (W7 / issue #17). But Durable resumes tasks automatically once the scheduler starts |
| Explicit-only `--resume` (`D3`/`D4`) | `--resume` is the only reader of the snapshot; config-hash mismatch refuses (`loadSession` in src/pi/extension.ts); `buildResumeBriefing` never re-dispatches; issue #17 acceptance "a crash never auto-resumes" | **Philosophical conflict.** Durable's own model: "Work interrupted by a crash or close stays pending. `resume()` starts the task scheduler; submitting or waiting starts it too" (README-v1.0.0.md:113) |
| Tool replay safety / idempotent re-run | None. In-flight edits are explicitly unrecoverable (`buildResumeBriefing`); #17's risk note names "double-applying edits" as the failure mode | **Complementary and the highest-value single piece.** A `replay: safe` discipline is directly usable as a design rule even without the library |
| `requestId` exactly-once submissions | Bus correlation registry + retry (src/runtime/correlation-registry.ts, src/bus/*) — transport-level, not admission-level | **Complementary** (different failure window: repo dedupes retries within a live run; Durable dedupes across process death) |
| Task graph: child tasks, `waiting on`, `allSettled`/`failFast` | None. Work orders are flat dispatches; `await_response` takes a single `agentId` → W2/W3 (~22% measured idle) | **Complementary.** Directly addresses W3/U3, but only reachable if work orders become durable tasks |
| Subagents as task-owned conversations | Peers as separate OS processes in herdr panes (`Runtime.spawnPeers`, src/herdr/pane-manager.ts) | **Replacement only.** Adopting it costs E2 (live panes) and E3 (per-process permissions) |
| Multi-client live view (`viewState`/`watch`/`watchEvents`) | Status title + `herdr pane read` + bus events (E2); `src/herdr/status-adapter.ts` | **Complementary** — replaces the pane text channel, does not replace the pane |
| Per-conversation agent (model/tools/cwd/instructions) | `PeerConfig` per agent (src/peer/peer-config.ts), tool sets from permissions (src/pi/tool-permissions.ts), `permission-gate.ts` | **Duplicate in intent, weaker in the repo.** Repo additionally gates at the tool boundary; Durable gates via `callers`/`modelTools`/hooks |
| Usage/cost accounting | `UsageAccounting` + `BudgetEnforcer` + pricing resolver + per-agent and session ceilings (src/budget/*, `BudgetEnforcer`) | **Repo is ahead. Durable has no budget enforcement** — it records per-conversation/per-tool usage (`UsageDoc`). Adoption here is a downgrade |
| File-mutation serialization | Exact-file locks across processes (src/locks/file-lock-manager.ts, 86 lines) | **Do not adopt.** Durable serializes `edit`/`write` per environment id + path inside one process (tools/file-mutation-queue.ts) |
| App state as committed documents | Artifacts by convention: `plan.md`, `findings.md`, `final.md` (src/artifacts/final-writer.ts, 92 lines) | **Complementary but nothing needs it.** No atomic coupling between artifact and transcript is required today |
| Compaction / reset / handoff | None in-repo; peers rely on pi's session layer (repo only observes the `compaction_start`/`compaction_end` events in src/peer/peer-session.ts) | **Complementary only if peers move onto Durable** |
| Extension registry with live replacement | pi extension system + skills/prompt templates loaded by the peer's `DefaultResourceLoader` (the pi imports in src/peer/peer-main.ts) | **Different host.** Durable extensions are not pi extensions |
| Storage backends + conformance + benchmarks | `run-state.json` (161-line module) | **Complementary, unused capacity** |
| Ownership tree + bottom-up abort | `stop_all` / `kill_all` / graceful-stop→bounded-grace→force-kill→teardown→aborted `final.md` (src/control/abort.ts, `abortSession`); `restart_agent` | **Duplicate at a coarser grain.** Durable's tree semantics are better, but repo semantics are process-level and already tested |

Directionally: Durable covers the *execution* substrate (F2, F3, F4, F7), the repo covers the *governance*
substrate (E1, E3, E5, E6), and the two currently disagree about one explicit design decision (D3/D4
explicit-only resume vs scheduler-start resume).

## 4. Adoption cost and blast radius

Nothing here is speculative file-counting: `src` is 7,665 lines / 69 files, and the modules named below
are the ones that would move.

**What would have to be rewritten**

1. **The supervisor stops being a pi extension.** The whole product entry point is a pi extension loaded
   by the `pi` CLI and registered in `~/.pi/agent/settings.json` (README "Activate globally";
   src/pi/extension.ts, eleven registered tools: `list_agents`, `peer_status`, `dispatch_work_order`,
   `collect_reports`, `send_prompt`, `await_response`, `finalize`, `stop_all`, `stop`, `kill_all`,
   `restart_agent`). A Durable `Harness` is a host process,
   not an extension: adopting it means re-hosting the supervisor, losing `ctx.ui.notify` / `ctx.modelRegistry`
   / `pi.registerTool` / `/login`, which are used throughout `src/pi/` (1,145 lines).
2. **The peer agent loop.** Peers are `bun src/peer/peer-main.ts` (the command `peerCommand` builds) built on pi's
   `createAgentSession`, `SessionManager`, `DefaultResourceLoader`, `ModelRuntime`
   (the pi imports in src/peer/peer-main.ts). On Durable they become `pi.generation`/`pi.tool` tasks over Durable's
   `CodingTools`, which ship exactly four tools: read, write, edit, bash
   (`packages/durable/src/tools/index.ts`, 22 lines). Breaking with it: the permission gate
   (src/peer/permission-gate.ts), the shell allowlist (src/pi/tool-permissions.ts), the tool-call audit log
   (src/peer/tool-call-logger.ts), the web tool (src/peer/web-tool.ts), the pane status title
   (src/herdr/status-adapter.ts), and skill loading for the templates' `ponytail`/`caveman`/`fallow` skills.
   Rebuilding pi's system-prompt sections (skills, AGENTS.md, tool contributions) requires
   `../../core/*` internals of the pi monorepo: the vendor's own Durable coding agent imports
   `../../core/resource-loader.ts`, `../../core/skills.ts`, `../../core/model-runtime.ts`
   (`experimental/durable/prompt.ts`, `harness-setup.ts`), while the *published* `pi-coding-agent`
   exports only `.`, `./rpc-entry`, `./client`, `./experimental/plugin` and its `files` list excludes
   `dist/experimental` and `dist/client`. **A consumer of the published package cannot reconstruct the peer
   surface without reimplementing it.**
3. **Panes.** `src/herdr/` (249 lines, incl. `pane-manager.ts`, `herdr-client.ts`) plus the `HERDR_ENV`
   guard (`inHerdr`, src/pi/launch.ts) and the rest of `src/pi/launch.ts` become vestigial once peers are conversations in
   one process. E2 ("Live OS-level panes… In-process subagents are invisible while running",
   docs/landscape-and-positioning.md:10) is surrendered by construction.
4. **Two state models.** `src/runtime/run-state.ts` (161 lines) documents itself as "a derived state record,
   never a script for re-applying work" and `buildResumeBriefing` refuses to re-dispatch.
   Durable's resume *is* re-application of unfinished tasks. Keeping both means two overlapping recovery
   contracts; deleting run-state means reopening issue #17 and D3/D4.
5. **Config surface.** `session.yaml` (src/contracts/session-schema.ts; the contracts dir is 387 lines) has no place
   for extension names, tool selections, `requestId` namespaces or task definitions. New schema, new
   validation, new templates, new guard tests.
6. **Dependency/runtime skew.** Repo runs peers under Bun 1.4.2 (`peerCommand`) with
   `@earendil-works/pi-coding-agent@^1.0.4` installed (1.0.4) and `typebox` pinned 1.3.27; Durable 1.3.0
   pins `typebox` 1.3.27 (match, good) and pulls `pi-ai` 1.3.0 + `pi-codemode` 1.3.0 + `chord` 1.3.0 +
   `photon`. `node:sqlite` `DatabaseSync` is present in Bun 1.4.2 (local probe), but Durable's CI is
   Node 22 only. Bun support is **UNVERIFIED**.

**What is preserved:** E1 contract gate (src/contracts/criteria.ts, src/validation/), the scorecard
(src/scorecard/, 1,021 lines), the JEV injection gate (src/jev/, 291 lines), budget policy and enforcement
(src/budget/, 198 lines), file locks (src/locks/, 86 lines), artifacts (src/artifacts/, 92 lines), stack
profiles (src/stack/, 183 lines) — 2,330 lines, ~30% of src — plus the A2A bus and control plane *if* peers
stay separate processes (src/bus 221 + src/control 165).

**Quantified at-risk surface:** `src/runtime` (1,822) + `src/pi` (1,145) + `src/peer` (1,361) + `src/herdr`
(249) + `src/logging` (40) = 4,617 lines, **60% of src**, plus the 84-file / 12,352-line test suite's peer,
runtime and harness coverage.

**Risks, ranked**

- **R1 — You lose the thing the positioning doc calls the product.** E2/E3/E4/E5 are all implemented in the
  modules above; Durable supplies none of them (`pi-durable` post: it is storage plus the machinery to run
  conversations; no budgets, no locks, no attestation, no fault taxonomy, no panes).
- **R2 — Vendor-internal integration path.** The only worked example of "pi + Durable" is a monorepo-only
  demo that imports unexported pi internals; the published pi-coding-agent surface is four entry points.
- **R3 — API churn is measured, not hypothetical.** Five new subpaths and two new deps in 14 days between
  v1.0.0 and 1.3.0, under a README banner that says the API changes without notice.
- **R4 — Single-writer storage.** "One process owns a storage at a time; there is no cross-process locking"
  (README-v1.0.0.md:527). Any design where the supervisor and a peer both write the same run state is out;
  the vendor's own answer is one locked worker per session (`session-worker.ts:517-527`).
- **R5 — The bus/A2A work is not replaced.** Peers that are Durable conversations in one process do not need
  a unix-socket bus, but they also cannot be `herdr pane read`. Deciding this is deciding the strategic fork.

## 5. Verdict

**Adopt later, behind named triggers.** Do not adopt now, and do not adopt the whole library; if it is
adopted it is for exactly one bounded part — **peer conversation + task durability** (transcript that
survives a crash, per-step checkpoints, tool replay policy) — never the supervisor, budgets, locks or
attestation, all of which the repo already does better and in-process.

Justification against this repo's actual constraints: (1) the repo's product per
docs/landscape-and-positioning.md:9-15 is the contract gate, control plane, fault taxonomy and pane
visibility — Durable provides none of these, so adoption cannot be justified as "replacing work"; it can
only be justified as filling the durability hole that W7 and issue #17 name. (2) That hole is real:
peers run `SessionManager.inMemory()` (src/peer/peer-main.ts) and the resume briefing lists peer
context and in-flight edits as unrecoverable (`buildResumeBriefing`), and #17's execution-mode
note calls "double-applying edits" the highest-risk failure. (3) Filling it with Durable today requires
either giving up the pi-native peer surface (blocked by R2: published pi exposes none of the internals the
vendor's own Durable coding agent imports) or running Durable in a sidecar process, which buys nothing the
existing snapshot does not. (4) The repo has not yet picked the strategic fork
(docs/landscape-and-positioning.md:49);
choosing Durable as a peer runtime is the "Platform + U1 in-process peers" branch, and burning that decision
on a package whose API moved 5 subpaths in 14 days is premature.

Triggers that flip this to "adopt for peer durability":

- **T1** The vendor publishes a supported, exported pi integration path (a pi-compatible prompt/skills/auth
  surface importable from `@earendil-works/pi-coding-agent`'s exports map) instead of the monorepo-only
  `experimental/durable` demo.
- **T2** The repo decides the fork as Platform + U1: non-observed peers become in-process sessions. At that
  point Durable is the only maintained implementation of exactly that, and hand-rolling checkpoints/ownership
  is more work than adopting it.
- **T3** Crash-with-context-loss becomes a measured top mistake class in the `.mypi` corpus / scorecard, i.e.
  the run-quality feedback loop proves this is the constraint and not W1/W2/W3.

**Counterargument (the honest case for adopting now):** the repo's own W2/W3 and issue #17 say it lacks both a
task graph and recovery, and it is currently hand-rolling a weaker version of both in a 161-line snapshot
plus a single-agent `await_response`. Durable ships a tested task graph with `failFast` fan-out, bottom-up
abort, exactly-once submissions and replay policy — 15.5k lines and 42 test files of work the repo would
otherwise build badly. If the supervisor is going to be re-hosted anyway when the fork resolves, paying the
migration twice is the real waste, not adopting early. The counter-counter is R2: today the pi-native peer
surface cannot be reconstructed from published packages, so the migration is blocked on the vendor, not on
this repo's appetite.

## 6. Open questions

- **Q1 — Does the Harness actually run under Bun 1.4.2?** Check: install into a scratch dir and run
  `test/examples/17-coding-tools.ts` and `test/examples/13-recovery.ts` under `bun` (needs a dependency
  install, which this worktree forbids), or run Durable's vitest suite under `bun test`. Partial evidence
  only: `node:sqlite` exposes `DatabaseSync` in Bun 1.4.2 and the portable cores contain no `node:` imports.
- **Q2 — Can a published-package consumer reproduce the peer surface?** Check: write a 30-line spike importing
  only from `@earendil-works/pi-coding-agent` (exports: `.`, `./rpc-entry`, `./client`,
  `./experimental/plugin`) that loads skills, AGENTS.md and the pi system prompt; if it needs `../../core/*`,
  the answer is no and T1 is not satisfied.
- **Q3 — Is crash-with-context-loss a real constraint?** Check: count `AGENT_CRASHED` / `run-state-write`
  events and mistake classes across the `.mypi` corpus (`docs/agents/issue-tracker.md` is how the decision
  gets recorded; the run-quality epic owns the corpus). If it is not top-3, T3 stays false.
- **Q4 — Would in-process Durable peers actually be cheaper?** Check: the head-to-head spawn/RSS benchmark
  that docs/landscape-and-positioning.md:62 says has not been run (W1 is "architectural, not benchmarked").
- **Q5 — What is the vendor's stability commitment?** Check: CHANGELOG per release + the README banner + the
  `dist-tags` set on each publish. Baseline today: one release line, banner still present at 1.3.0,
  five new subpaths in 14 days.
- **Q6 — Who writes the run state if peers are Durable conversations?** Check: design against
  README-v1.0.0.md:527 and `session-worker.ts:517-527`; one process per storage is the constraint, so the
  supervisor must consume a read-only view or a socket, not open the same storage.
- **Q7 — Does Durable's abort reach OS-level effects?** Check: adversarial test — abort a task whose tool is a
  spawned `herdr`/`bash` process; Durable aborts tasks and awaits them, the repo's `abortSession`
  (`abortSession` in src/control/abort.ts) also terminates panes.

## 7. Sources

Fetched 2026-10-16, 23:13:12–23:13:27 UTC (anchor-post and source fetches started 23:09 UTC).
Raw `curl -s -o /dev/null -L -w '%{http_code}'` + ISO timestamp, one URL per line, 98 URLs, all `200`:

```text
200  2026-10-16T23:13:12Z  https://earendil.com/posts/pi-durable/
200  2026-10-16T23:13:12Z  https://earendil.com/posts/what-is-a-harness/
200  2026-10-16T23:13:12Z  https://earendil.com/posts/pi-1-0/
200  2026-10-16T23:13:12Z  https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/README.md
200  2026-10-16T23:13:13Z  https://api.github.com/repos/earendil-works/pi/contents/packages/durable?ref=v1.0.0
200  2026-10-16T23:13:13Z  https://api.github.com/repos/earendil-works/pi/contents/packages/durable/src?ref=v1.0.0
200  2026-10-16T23:13:13Z  https://api.github.com/repos/earendil-works/pi/contents/packages/durable/test?ref=v1.0.0
200  2026-10-16T23:13:13Z  https://api.github.com/repos/earendil-works/pi/contents/packages/durable/test/examples?ref=v1.0.0
200  2026-10-16T23:13:14Z  https://api.github.com/repos/earendil-works/pi/contents/packages/durable/docs?ref=v1.0.0
200  2026-10-16T23:13:14Z  https://api.github.com/repos/earendil-works/pi/contents/packages/coding-agent/src/experimental/durable?ref=v1.0.0
200  2026-10-16T23:13:14Z  https://api.github.com/repos/earendil-works/pi/contents/packages/coding-agent/src/experimental?ref=v1.0.0
200  2026-10-16T23:13:15Z  https://api.github.com/repos/earendil-works/pi/git/trees/v1.0.0?recursive=1
200  2026-10-16T23:13:16Z  https://api.github.com/repos/earendil-works/pi/contents/.github/workflows?ref=v1.0.0
200  2026-10-16T23:13:16Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/package.json
200  2026-10-16T23:13:16Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/README.md
200  2026-10-16T23:13:16Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/CHANGELOG.md
200  2026-10-16T23:13:16Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/docs/spec.md
200  2026-10-16T23:13:16Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/test/storage-runtime-boundary.test.ts
200  2026-10-16T23:13:16Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/chord/README.md
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/package.json
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/durable/README.md
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/durable/runtime.ts
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/durable/sessions.ts
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/durable/harness-setup.ts
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/durable/prompt.ts
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/coordinator.ts
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/session-worker-manager.ts
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/session-worker.ts
200  2026-10-16T23:13:17Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/server.ts
200  2026-10-16T23:13:18Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/coding-agent/src/experimental/client.ts
200  2026-10-16T23:13:18Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/.github/workflows/ci.yml
200  2026-10-16T23:13:18Z  https://registry.npmjs.org/@earendil-works%2Fpi-durable
200  2026-10-16T23:13:18Z  https://registry.npmjs.org/@earendil-works%2Fpi-ai
200  2026-10-16T23:13:18Z  https://registry.npmjs.org/@earendil-works%2Fchord
200  2026-10-16T23:13:18Z  https://registry.npmjs.org/@earendil-works%2Fpi-server
200  2026-10-16T23:13:19Z  https://registry.npmjs.org/@earendil-works%2Fpi-client
200  2026-10-16T23:13:19Z  https://registry.npmjs.org/@earendil-works%2Fpi-protocol
200  2026-10-16T23:13:19Z  https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.3.0.tgz
200  2026-10-16T23:13:19Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/documents.ts
200  2026-10-16T23:13:19Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/entries.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/env/index.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/env/node.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/errors.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/agent.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/compaction.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/context.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/define.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/events.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/generation.ts
200  2026-10-16T23:13:20Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/harness.ts
200  2026-10-16T23:13:21Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/inbox.ts
200  2026-10-16T23:13:21Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/json.ts
200  2026-10-16T23:13:21Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/live.ts
200  2026-10-16T23:13:21Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/output.ts
200  2026-10-16T23:13:21Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/prompt.ts
200  2026-10-16T23:13:21Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/registry.ts
200  2026-10-16T23:13:21Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/scheduler.ts
200  2026-10-16T23:13:21Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/submissions.ts
200  2026-10-16T23:13:21Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/task-graph.ts
200  2026-10-16T23:13:22Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/tool.ts
200  2026-10-16T23:13:22Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/types.ts
200  2026-10-16T23:13:22Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/usage.ts
200  2026-10-16T23:13:22Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/util.ts
200  2026-10-16T23:13:22Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/harness/view.ts
200  2026-10-16T23:13:22Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/ids.ts
200  2026-10-16T23:13:22Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/index.ts
200  2026-10-16T23:13:22Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/session/forks.ts
200  2026-10-16T23:13:22Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/session/observation.ts
200  2026-10-16T23:13:23Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/session/session.ts
200  2026-10-16T23:13:23Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/session/transaction.ts
200  2026-10-16T23:13:23Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/storage/jsonl/index.ts
200  2026-10-16T23:13:23Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/storage/jsonl/node.ts
200  2026-10-16T23:13:23Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/storage/jsonl/storage.ts
200  2026-10-16T23:13:23Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/storage/memory.ts
200  2026-10-16T23:13:24Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/storage/sqlite/database.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/storage/sqlite/index.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/storage/sqlite/migrations.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/storage/sqlite/node.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/storage/sqlite/storage.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tasks.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/testing/assertions.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/testing/index.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/testing/runner.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/testing/storage-benchmark.ts
200  2026-10-16T23:13:25Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/testing/storage-conformance.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/testing/types.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/bash.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/edit-diff.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/edit.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/env.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/file-mutation-queue.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/image.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/index.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/path-utils.ts
200  2026-10-16T23:13:26Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/read.ts
200  2026-10-16T23:13:27Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/write.ts
200  2026-10-16T23:13:27Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/truncate.ts
200  2026-10-16T23:13:27Z  https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/types.ts
```

Local sources read (not fetched):

- `docs/landscape-and-positioning.md` (§E positioning, §W weaknesses, §U unit-of-work options, "The strategic
  fork", and the caveat that the efficiency comparison is architectural rather than benchmarked)
- `docs/agents/domain.md`, `docs/agents/issue-tracker.md`, `AGENTS.md:3-5`
- `src/runtime/run-state.ts` (`RunStateV1Schema`, `hashConfig`, `buildRunState`, `writeRunState`, `readRunState`,
  `buildResumeBriefing`), `src/runtime/runtime.ts` (`spawnPeers`, `peerCommand`, `dispatch`, `finalize`,
  `writeRunStateSnapshot`, `markCrashed`), `src/pi/extension.ts` (`parseLaunchArgs`, `loadSession`, `startRun`,
  the eleven tool registrations), `src/peer/peer-main.ts`, `src/peer/peer-config.ts` (`PeerConfig`,
  `toolsForPermissions`), `src/peer/peer-session.ts`, `src/logging/conversation-log.ts`, `src/control/abort.ts`,
  `src/budget/budget-enforcer.ts`, `src/pi/launch.ts` (`inHerdr`), `README.md`, `package.json`
- GitHub issue #17 (`gh issue view 17`), including the landing comment dated 2026-10-16T22:58:30Z
  ("Landed: 7e68e8d"), per `docs/agents/issue-tracker.md`.

---
