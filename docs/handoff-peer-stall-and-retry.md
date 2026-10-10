# Handoff — peer stalls and late/transient failures (from pi-nobash runs 1–2)

**Target repo:** `multi-agent` at `/Users/afshin/Documents/dev/multi-agent`
**Evidence:** `~/Documents/dev/pi-nobash/.mypi/task-implement-{1,2}/run-details/conversation.jsonl`
**Companion doc:** `docs/handoff-multi-agent-run-robustness.md` (MT-1…MT-7)
**Status:** A1–A5 implemented.

## Why this doc exists

`handoff-multi-agent-run-robustness.md` MT-1/MT-2 target peers that are *mute from
first contact*. Re-reading the two runs showed a second, distinct failure class:
a peer that passes the ping, works, then returns a **late, metered, transient**
empty reply mid-run. This doc records the evidence and the decisions for that
class. It is deliberately separate from the MT numbering.

## Findings

- **F1 — No agent crashed in either run.** `AGENT_CRASHED` count is `0` in both
  `conversation.jsonl`. The failures were output failures, not liveness failures:
  mute (early), budget stop (late), correlation timeout (late), empty report
  (late). Any framing of these as "crashes" is wrong.
- **F2 — Run 1 `pi_core` failed early, at the ping.** Its four empty `RESPONSE`
  frames are events #9/#14/#16/#18 in run 1, all **before the first
  `WORK_ORDER` (#19)**. MT-1 (preflight) and MT-2 (mute detection) target this
  class correctly.
- **F3 — Run 2 `reviewer` failed late and was metered.** Ping #8 → reply #12
  (`len=4`, $0.0006, OK). Then prompt #25 → **empty `RESPONSE` #26 with cost
  $0.0136 / 314 511 tokens** → 1800 s `await` ERROR #27 → re-prompt #28 →
  recovered #29 (`len=7211`). MT-2 as implemented requires *empty AND zero
  usage*, so it does **not** cover this metered empty. MT-2's own evidence cites
  this case; its mechanism does not match its evidence.
- **F4 — Stall detection is turn-level, not process-level.** Peers emit
  `HEARTBEAT` every 1 s and keep beating during a model turn, so a hung or silent
  turn is indistinguishable from a slow one. The runtime only marks
  `AGENT_CRASHED` when beats stop (`heartbeat_timeout_ms`, default 3000 ms). A
  live-but-stalled peer is invisible until the supervisor's await timeout
  (default 120 000 ms; 1 800 000 ms in run 2).
- **F5 — Run 2's hang pattern.** An empty `send_prompt` reply, followed by the
  supervisor opening a long `await_response` for a message that never arrived.
  The empty reply is the trigger; the blind await is the cost.

## Decisions

- **D1** Implement **A1–A5**. A5 is notify-only (no kill): the supervisor gets a
  fast `AGENT_STALLED` cue and decides.
- **D2** Reuse `peer_max_retries` / `peer_retry_pause_ms` for conversational-turn
  retries. **No new config field.**
- **D3** After retries, an empty conversational reply escalates to
  `AGENT_UNUSABLE` (uniform with the work-order mute path) instead of sending an
  empty `RESPONSE`.
- **D4** The work-order path is unchanged: it retries on any empty report and
  escalates only when empty **and** zero usage; a metered empty work-order report
  remains a `FINAL_REPORT` annotated by MT-4 in `findings.md`.

## Actions

| TODO | Item | Class | Status |
|---|---|---|---|
| A1 | Retry an empty `PROMPT` turn, then escalate to `AGENT_UNUSABLE` | `[CODE]` | done |
| A2 | Supervisor prompt: re-ask an empty reply; never follow it with a long await | `[DOC]` | done |
| A3 | On a wait timeout, report whether the peer is still working or terminal | `[CODE]` | done |
| A4 | Guide/template notes for the above | `[DOC]` | done |
| A5 | Turn-progress beacon + `session.stall_timeout_ms` + `AGENT_STALLED` | `[CODE]` | done |

**A1** `src/peer/peer-harness.ts`: `runPromptWithRetry` retries while the reply is
empty/whitespace under the shared `RetryPolicy`; the last attempt either ships a
`RESPONSE` or an `AGENT_UNUSABLE` (`attempts = maxRetries + 1`). The `muteStreak`
special case is removed. Covers the metered-empty case (F3) because it retries
on emptiness regardless of usage.

**A3** `src/pi/extension.ts`: `describeWaitFailure(state, agentId, timeoutMs,
message)` distinguishes `CRASHED` / `STOPPED` / still-working / unknown for the
`send_prompt` and `await_response` failure text.

**A5** `src/contracts/{session-schema,a2a-schema}.ts` add `session.stall_timeout_ms`
(default 300000; `0` disables) and `AGENT_STALLED` + optional `busy`/`progressed` on
`HEARTBEAT`; `src/peer/peer-session.ts` tracks open-turn progress via
`progressSnapshot()`; `src/peer/peer-main.ts` reports it on the 1 s heartbeat;
`src/runtime/runtime.ts` emits `AGENT_STALLED` (once per episode) and wakes the
await via `PeerMessaging.onStalled` without stopping the peer. Design and evidence:
`docs/a5-turn-progress-stall-detection.md`.

## Config impact

None required: A1–A4 add no consumed config fields. `peer_max_retries` /
`peer_retry_pause_ms` now also govern conversational turns. `peer_prompt_timeout_ms`
remains the default per-call timeout.

## Known limits

- A1 detects **empty** replies, not "slow but working" turns. A5 detects an open
  turn with no progress for `stall_timeout_ms` (default 300 s), above the longest
  observed single tool (~2 min).
- Retries spend tokens on legitimately terse replies; bounded by
  `peer_max_retries`.
- The supervisor can still choose a long `timeoutMs`; A2 is prompt discipline, not
  enforcement.

**Most important:** A1 removes the empty reply that run 2 hung on, so the observed
30-minute blind wait cannot recur from that trigger; A2 stops the supervisor from
turning an empty reply into a long await; A3 gives the supervisor the
live-vs-terminal distinction it lacked. Only A5 adds true quick stall detection.
