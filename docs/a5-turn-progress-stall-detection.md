# A5 — turn-progress channel and stall detection

**Status:** implemented (A5 of `docs/handoff-peer-stall-and-retry.md`).
**Goal:** let the supervisor notice a **live but stalled** peer quickly, instead of
waiting out a 120 s–1800 s await timeout.

## Research (verified, not assumed)

**Event model.** `AgentSessionEvent` (pi SDK `core/agent-session.d.ts`) extends `AgentEvent`
(`@earendil-works/pi-agent-core/dist/types.d.ts:450`) minus `agent_end`, plus session events.
A turn emits, in order, activity-bearing events:
`agent_start`, `turn_start`, `message_start`, `message_update` (text/thinking deltas),
`message_end`, `tool_execution_start|update|end`, `turn_end`; plus session events
`auto_retry_start|end`, `compaction_start|end`, `bash_execution_update`, and finally
`agent_settled`. A hung turn emits **none of these after the last progress** — but the
process keeps heartbeating.

**Heartbeat.** `src/peer/peer-main.ts` runs a top-level `setInterval(..., 1000)` that keeps
beating during an awaiting turn (event loop free), so heartbeats prove process liveness,
not turn progress. `HeartbeatMonitor` (`src/runtime/heartbeat-monitor.ts`) marks a peer
`AGENT_CRASHED` only when beats stop.

**Turn boundary.** `PeerSession.runTurnInner` (`src/peer/peer-session.ts`) subscribes to
events and is bounded by `agent_settled`; that is the only place that knows a turn is open.

**Correlation.** `await_response`/`send_prompt` open waiters in `CorrelationRegistry`
timeout after `peer_prompt_timeout_ms`. `PeerMessaging.resolveAwait` resolves
`await:<recipient>`/`await:<sender>` (plus a target); `onCrash` adds `await:<agentId>`.

**Observed tool durations** (`tool-calls.jsonl`, runs 1–2): max single tool 120 711 ms
(task-2 `pi_core/bash`); task-1 max 5 151 ms; means 0.5–1.7 s. A within-turn no-progress
window is therefore bounded by the longest single tool, ~2 min observed. A default
threshold of **300 000 ms** clears that with margin.

## Design

- **Progress signal (peer → runtime):** piggyback on the existing 1 s HEARTBEAT payload —
  `{ agentId, busy?: boolean, progressed?: boolean }`. `busy` = a turn is open;
  `progressed` = a progress event occurred since the previous beat. No new bus traffic, no
  new event from the peer. Fields are optional, so older peers/tests stay valid.
- **Progress events** (`isProgressEvent`): `agent_start`, `turn_start`, `turn_end`,
  `message_start`, `message_update`, `message_end`, `tool_execution_start|update|end`,
  `auto_retry_start|end`, `compaction_start|end`, `bash_execution_update`. Not progress:
  `agent_settled`, `queue_update`, `entry_appended`, `session_info_changed`,
  `thinking_level_changed`, `summarization_*`.
- **Runtime algorithm:** on a heartbeat, `busy=true && progressed` (or first busy beat)
  refreshes `turnProgress[agentId] = now` on the runtime's clock; `busy=false` clears the
  entry. The existing 1 s heartbeat scan also runs `checkStalls(now)`: for each open turn
  idle ≥ `session.stall_timeout_ms`, emit **`AGENT_STALLED`** `{agentId, reason, elapsedMs}`
  once per episode, resolve any pending await via `PeerMessaging.onStalled`, and **do not
  stop the peer** (notify-only). Progress or turn end clears the episode.
- **Config:** `session.stall_timeout_ms` (int ≥ 0, default 300000, `0` disables).
- **Recovery:** `AGENT_STALLED` reaches the supervisor through `await_response`. The prompt
  says: re-ask once with a short `timeoutMs` as a liveness probe (the prompt queues behind
  the current turn, so a busy peer answers when the turn ends), and only `restart_agent` /
  reassign if that probe also fails. No kill on the event itself.

## Why this avoids false positives

- The check only runs while a turn is open, so idle time between turns never counts.
- The threshold (5 min) exceeds the longest observed single tool by ~2.5×.
- Even a false positive is non-destructive: the re-ask queues rather than interrupts, and
  the peer is not stopped.

## Acceptance / tests

- `session.stall_timeout_ms` default and validation.
- `AGENT_STALLED` and the extended `HEARTBEAT` payload validate; invalid forms reject.
- `PeerSession` reports busy/progress correctly and consumes `progressed` once.
- Runtime: a busy, no-progress peer emits `AGENT_STALLED` and wakes `await_response`;
  a progressing peer does not; `busy=false` clears; `stall_timeout_ms: 0` disables.
- `replyText` renders `AGENT_STALLED`.

## Ponytail reconciliation

- Reuses the existing heartbeat, scan timer, correlation registry, and event bus. New
  surface is one optional config field, one event type, two optional payload booleans, one
  peer-session accessor, one runtime scan. No new timer, no new bus message from the peer,
  no state-machine change, no kill path.

## Review reconciliation

An independent review of the first cut found these; all are addressed:

- **Stall later than the default await.** `stall_timeout_ms` (300 s) > the default
  `peer_prompt_timeout_ms` (120 s), so a single default await times out first. The
  event still reaches the supervisor on a re-await (buffered per agent); the guide and
  supervisor prompt now state the `timeoutMs ≥ stall_timeout_ms` relationship.
- **First-turn blind spot.** `busy` is now set *before* the first `await getSession()`,
  so a hang in session creation is detectable.
- **Post-terminal re-arm.** `handleHeartbeat` ignores beats from `STOPPED`/`CRASHED`
  peers, so a late beat cannot re-arm the scan or leak a `turnProgress` entry.
- **Stale buffered stall.** `onStalled` buffers only under `await:<agentId>` (not the
  generic/`bus` keys), so a stall cannot hijack an unrelated wait.
- **False-positive path.** Notify-only plus the guide/prompt: a single stall is not
  grounds to reassign; a long tool can look stalled.
- **Minor.** `markStalled` now takes the scan's `now` instead of calling `this.now()`
  twice.
