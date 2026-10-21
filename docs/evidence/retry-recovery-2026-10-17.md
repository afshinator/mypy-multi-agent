# Fault injection — a retry that RECOVERS (2026-10-17)

Issue #5. The 2026-10-14 note proved that agent-level retries **fire**, using a slug that
fails permanently; it ended "Recovery is still unproven … producing that needs a provider
that fails once and then succeeds."

This is that run. `scripts/fault-inject.ts` now starts a loopback passthrough proxy and points
the peer's `openrouter` provider at it through a throwaway `PI_CODING_AGENT_DIR` (the only
seam that lands before `ModelRuntime.create` reads the model). The proxy answers the **first**
`/chat/completions` request with a retryable HTTP 500 and streams every later request to the
real upstream with the peer's own `Authorization` header. The second attempt is therefore a
real provider response, not a canned one.

Two runs, `just fault openrouter/cohere/north-mini-code:free 120`. The peer config sets
`retryMaxRetries: 0` so a second _harness_ turn can never be mistaken for pi's agent-level retry.

## Run 1

```
bus: /var/folders/.../fault-inject-XXXX/run-details/bus.sock
model: openrouter/cohere/north-mini-code:free
[shim] one-shot 500 -> /var/folders/.../fault-inject-XXXX/agent

   0.0s  AGENT_REGISTER   {"agentId":"probe","title":"probe","model":"openrouter/cohere/north-mini-code:free",...}
   0.0s  -> PROMPT sent
[proxy] call#1 POST /api/v1/chat/completions        <- answered 500, retryable
   2.0s  HEARTBEAT.retry  RETRY 1/3
[proxy] call#2 POST /api/v1/chat/completions        <- streamed to the real upstream
  18.2s  RESPONSE         {"agentId":"probe","text":"PONG","usage":{"cost":0,"tokens":3682}}
```

## Run 2 (repeat)

```
[proxy] call#1 POST /api/v1/chat/completions
   2.0s  HEARTBEAT.retry  RETRY 1/3
[proxy] call#2 POST /api/v1/chat/completions
  17.6s  RESPONSE         {"agentId":"probe","text":"PONG","usage":{"cost":0,"tokens":3643}}
```

Both runs: `frames: AGENT_REGISTER, RESPONSE` and `retry transitions: 1`, no `AGENT_UNUSABLE`.

## Run 3 (after extracting the pure helpers)

```
[proxy] call#1 POST /api/v1/chat/completions
   2.0s  HEARTBEAT.retry  RETRY 1/3
[proxy] call#2 POST /api/v1/chat/completions
  18.8s  RESPONSE         {"agentId":"probe","text":"PONG","usage":{"cost":0,"tokens":3694}}
```

The `failFirstChat` / `stripHopHeaders` extraction changed no behaviour: same sequence, same
17 to 19 s window (one 15 s backoff), same single `RESPONSE`.

## Reached the bus (run 1)

```json
{
  "id": "resp-probe-1792216355387",
  "correlationId": "prompt-1",
  "timestamp": 1792216355387,
  "sender": "probe",
  "recipient": "supervisor",
  "type": "RESPONSE",
  "payload": {
    "agentId": "probe",
    "text": "PONG",
    "usage": { "cost": 0, "tokens": 3682 }
  }
}
```

## Summary (run 1)

```
model: openrouter/cohere/north-mini-code:free
frames: AGENT_REGISTER, RESPONSE
retry transitions: 1
     2.0s  RETRY 1/3
```

## What this settles

- **A retry recovers, observed rather than inferred.** Attempt 1 was a 500; attempt 2, ~15 s
  later, was a real upstream answer. The turn completed with `RESPONSE … "PONG"`.
- **The harness saw one successful attempt.** `attempts` never appears because no
  `AGENT_UNUSABLE` was emitted: the retry was invisible to `PeerSession`, exactly as it should
  be when it works. `retryMaxRetries: 0` rules out a second harness turn.
- **The cadence matches RT-10's setting.** Retry started at 2.0 s (after the 500) and attempt 2
  landed at ~17.6/18.2 s: one `baseDelayMs: 15000` wait, confirmed live rather than from config.
- **The bus contract is unchanged.** Retry still surfaces only as `HEARTBEAT.retry`; the
  supervisor gets a normal `RESPONSE` with non-zero usage (`tokens: 3682` / `3643`).

## What this does not settle

- **No `retry cleared` beat was captured.** The recovered attempt finished its turn on the same
  beat, so the retry edge is the only retry frame; recovery is evidenced by call #2 and the
  `RESPONSE`, not by a clearing heartbeat. That is a race in the observation, not in the retry.
- **This is the peer path only** (`peer-main` → `PeerSession` → `AgentSession`). It does not
  exercise the supervisor's own turn, `--resume`, or a full `just task` run.
- **A free model was used**, so latency (≈17 s including the 15 s backoff) is not representative
  of paid providers; only the retry semantics are.
- **The first failure was a 500 before any stream bytes.** A mid-stream provider failure is a
  different code path and remains unmeasured.
