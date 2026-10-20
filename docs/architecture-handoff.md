# Architecture handoff

**Verified at commit `1dd4e6e`.** The code is the truth; this file is
orientation. If a claim here disagrees with `src/`, believe the code and fix this
file. Every mechanism named below is a real symbol you can grep.

## 1. What this is

Local-first multi-agent orchestration for software work, built as a pi extension.
One **supervisor** (an LLM in your terminal) dispatches work orders to N **peer**
agents. Each peer is a real `bun` process running pi in its own herdr pane, on
its own model, with its own permissions and budget. Peers and supervisor talk
over a unix-domain socket bus. There is no server, no browser UI, no database,
and no network egress except the model providers and a peer's `web_fetch`. The
state of a run is files under a `<taskDir>/<task>/` directory named by the root
`mypi-multi-agent.yaml`.

The reason it exists: a single coding agent serializes everything through one
context. A roster of specialised agents, each with a narrow brief, is how you get
heterogeneous review, parallel work, and an auditable decision record.

## 2. One run, in order

1. **`/mypi-multi-agent [--resume] [name]`** — `src/pi/extension.ts`.
   `parseLaunchArgs` splits the argument; `loadSession` decides *whether* a run
   may start (resolve the config via taskDirs — never scaffold — strict-parse it, validate a
   `--resume` snapshot with `hashConfig`, warn on unpriced models, run the M4/M5
   advisories, pre-flight every model); `startRun` builds the `Runtime`, calls
   `start()` or `resume()`, then `spawnPeers()`. Refuses to run outside a herdr
   pane.
2. **Panes** — `Runtime.spawnPeers` → `PaneManager.spawnAll` opens one herdr pane
   per agent. Each pane runs `bun src/peer/peer-main.ts --agent <id> --bus <sock>
   --model <slug>`, i.e. a separate OS process with its own pi session.
3. **Registration** — each peer sends `AGENT_REGISTER`, then `HEARTBEAT` every
   1 s. `AgentRegistry` binds `connectionId ↔ agentId`; a missing heartbeat for
   `session.heartbeat_timeout_ms` is `AGENT_CRASHED`.
4. **Dispatch** — the supervisor's `dispatch_work_order` sends `PROMPT`. Every
   inbound frame is chained onto its connection's `Runtime.dispatchChains`
   promise, so frame N+1 is not handled before frame N's gate settles. The
   optional Jev injection gate screens the frame *behind* that chain and only
   annotates it.
5. **Work** — the peer uses its pi tools. The first successful `edit`/`write`
   makes `change-notifier.ts` emit `INTENT_TO_MODIFY`, which arms
   `ChangeDetector` and therefore the validation gate. Mutations through `bash`
   do **not** arm it.
6. **Report** — the peer answers `RESPONSE` (intermediate text) or `FINAL_REPORT`
   (result, optional `criteria`, `usage`). The runtime books usage, enforces
   budget, and records the work order as completed for that agent.
7. **Attestation** — only `session.attester`'s verdict block is captured, and it
   **replaces** the previous one (`captureCriteria` → `peerCriteria`). It also
   stamps `criteriaAttestedAt`, the instant cited artifacts are compared against
   at finalize.
8. **Finalize** — `finalize` is three independent gates: the supervisor asserts
   the DoD, the attester's block must have exactly one `pass` per criterion in DoD
   order with criteria named verbatim and its cited files unchanged since
   attestation, and `validation.commands` must pass (only if code changed). The
   entry point is `Runtime.finalize`, and the phase machine is
   `SessionState` (`ACTIVE → FINALIZING → COMPLETE | ABORTED`).
9. **Artifacts** — `FinalWriter` writes `final.md` (frontmatter + cost + the
   supervisor's decision) and `findings.md` (raw per-peer reports; empty reports
   are annotated as such). `/finalize` then removes the transient peer configs
   and the socket; a crash or abort leaves them for inspection.

## 3. Where state lives

```
<taskDir>/<task>/session.yaml      authored config — the only hand-written file
<taskDir>/<task>/run-details/
  .a2a-agent-bus.sock              unix socket (resolveSocketPath)
  plan.md                          required by the run-contract gate
  final.md                         decision record + cost breakdown
  findings.md                      raw peer reports
  conversation.jsonl               bus frames (HEARTBEAT deliberately not logged)
  tool-calls.jsonl                 tool name/args/result per call
  run-state.json                   resume snapshot: phase, config hash, accounting
  scorecard.json                   opt-in (session.record_scorecard)
```

Nothing else persists. A `--resume` reads `run-state.json` and **refuses** when
`hashConfig(rawSessionYaml)` no longer matches `configHash` — an edited config
invalidates the snapshot instead of silently resuming into a different run.

## 4. Invariants worth knowing before answering design questions

| Invariant | Enforced by |
|---|---|
| Config is a strict Zod contract; an unknown key fails the launch | `src/contracts/session-schema.ts` |
| One authority per concern: exit codes, session phase, agent identity, budget | `runtime/exit.ts`, `control/session-state.ts`, `AgentRegistry`, `budget/` |
| Only the attester's verdict block counts; a non-attester's is logged and ignored | `captureCriteria` |
| Criteria are replaced, never accumulated across reports | `peerCriteria = criteria` |
| A verdict whose cited file changed after attestation is stale → rejected | `staleCitations` + `attesterReadTimes` |
| Budgets are OR'd thresholds per agent plus a global session ceiling; a stop is graceful and can wait for a work-order boundary | `budget-enforcer.ts`, `stop_at_work_order_boundary` |
| Malformed bus frames are counted in a sliding window; crossing the threshold triggers the stop-on-protocol-fault policy (the peer is stopped) | `bus/malformed-counter.ts` |
| Permissions are enforced at the pi tool layer, not in prompts | `toolsForPermissions`, `canShell` |
| A read-only peer's shell is exact-match allowlist only; no inference of "safe" | `canShell` |
| The Jev classifier annotates only: never drops a frame, never changes the exit code | `jev/verdict-advisory.ts`, `jev/injection-gate.ts` |
| Each validation command runs in its own process group and is killed by group at the bound | `defaultExecValidation` |
| Exit codes are `0` success, `1` failure, `2` user abort, `3` config error | `runtime/exit.ts` |

## 5. Module map (`src/`, ~7.7k LOC — rounded sizes, re-measure if it matters)

| Dir | LOC | What lives there |
|---|---|---|
| `runtime/` | 1822 | the orchestrator: `Runtime`, agent registry, dispatch, finalize, run-state snapshots, exit codes |
| `peer/` | 1361 | the peer process: `peer-main`, session, harness, config, permissions, change notifier, file lock |
| `pi/` | 1145 | the pi extension: command handler, launch/`loadSession`/`startRun`, model pre-flight, supervisor prompt, tool permissions |
| `scorecard/` | 1021 | per-run health scorecard, cross-project collector, trends, pre-run advisories |
| `contracts/` | 387 | A2A event catalogue + Zod schemas, session config schema, criteria |
| `supervisor/` | 332 | empty-turn watchdog, finalization/reconciliation, usage |
| `jev/` | 291 | classifier advisory and the inbound injection gate |
| `herdr/` | 249 | pane-control boundary: interface + real CLI client |
| `bus/` | 221 | socket server, JSONL framing, router, malformed-frame counter |
| `budget/` | 198 | budget policy and enforcement, usage accounting |
| `stack/` | 183 | repo probing for stack + available analyzers |
| `control/` | 165 | user-abort flow: graceful stop, bounded grace, force kill, teardown |
| `artifacts/` | 92 | `final.md` and `findings.md` rendering |
| `locks/` | 86 | exact-file locks, FIFO waiters, one-lock-per-agent deadlock avoidance |
| `validation/` | 72 | change detection and the validation runner |
| `logging/` | 40 | append-only JSONL writer behind `conversation.jsonl` / `tool-calls.jsonl` |

## 6. Decisions already made — do not re-litigate silently

- **Peers are OS processes in panes, not in-process sessions.** Buys isolation,
  observability (`herdr pane read`) and killability; costs the heaviest launch
  path reviewed (N bun processes + N panes + a socket).
- **The filesystem is the state store.** No database, no daemon. Resume is
  `run-state.json` plus a config hash.
- **Reviewer criteria are replaced, not accumulated,** and only the attester
  counts. Accumulation was rejected: it let an early weak pass outlive a later
  fail.
- **Validation commands are bounded by `finalization_grace_ms` (900 s) and killed
  by process group** (#42), because a wedged suite used to hang finalize.
- **The config schema is strict, so dead fields were deleted, not ignored** (#37).
  A config that sets one now fails loudly.
- **The Jev classifier never gates.** It writes advisories into `final.md`;
  the exit code is decided by DoD + verdicts + validation only.
- **`docs/multi-agent-spec-v1.6.md` is history.** The issue tracker is the source
  of truth for what should exist; `src/` is the truth for what does.

## 7. Known deferrals — do not report these as bugs

| Issue | State |
|---|---|
| #41 no peer can open a prompt | `PeerMessaging.sendPrompt` is reachable only from the supervisor's `send_prompt` tool; a peer's pi session has no tool that writes a `PROMPT`, so the peer→peer arm cannot start |
| #10 run-quality feedback loop | epic: turn past-run mistakes into measurable improvement |
| #7 Jev `ask_jev` tool and agent pre-flight (C7/C5) | deferred |
| #6 per-request peer usage metering | deferred |

## 8. Verify anything yourself

```
bun run test           # the skips are live E2E, which needs HERDR_ENV=1 and a model
bun run typecheck
biome check .          # 0 errors; warnings are pre-existing
fallow dead-code       # 6 findings, all pre-existing; exits 1 by design
fallow health          # graded health score + hotspots
gh issue list --state open
```

Boundaries that make the suite what it is: herdr is an injected interface, so
pane control is faked in tests and only the E2E touches real panes; model calls
are never made in unit/contract/integration tests.

## 9. Reading order for a newcomer

`GLOSSARY.md` (terms) → this file → `README.md` (what it does, how to run it) →
[`docs/agent-config-guide.md`](agent-config-guide.md) (every config field) →
`src/runtime/runtime.ts` (the whole orchestration in one file) →
`src/pi/supervisor-prompt.md` (what the supervisor is actually told).
