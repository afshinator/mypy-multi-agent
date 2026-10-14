# Fault injection — a live agent-level retry loop (2026-10-14)

Two runs of `scripts/fault-inject.ts`: one real peer process (`src/peer/peer-main.ts`) over a
real bus socket, driven by a script that registers, sends one PROMPT, and prints every
frame. No supervisor, no task run, no LLM in the driver — the peer is the only model.

## Control — a working slug (`openrouter/cohere/north-mini-code:free`)

```
bus: /var/folders/gs/n3wt6k6j2pg2l96hbw2fr5yr0000gr/T/fault-inject-36pMPC/run-details/bus.sock
model: openrouter/cohere/north-mini-code:free
waiting up to 60s…

   0.0s  AGENT_REGISTER   {"agentId":"probe","title":"probe","model":"openrouter/cohere/north-mini-code:free","permissions":{"read":true,"edit":false,"shell":false},"maxCostUsd":1,"systemPrompt":"You are a probe. When asked, reply with the single
   0.0s  -> PROMPT sent
   [peer stdout] P   [peer stdout] ONG   1.2s  RESPONSE         {"agentId":"probe","text":"PONG","usage":{"cost":0,"tokens":4355}}

=== reached the bus ===
{
 "id": "resp-probe-1792016141837",
 "correlationId": "prompt-1",
 "timestamp": 1792016141837,
 "sender": "probe",
 "recipient": "supervisor",
 "type": "RESPONSE",
 "payload": {
  "agentId": "probe",
  "text": "PONG",
  "usage": {
   "cost": 0,
   "tokens": 4355
  }
 }
}

=== summary ===
model: openrouter/cohere/north-mini-code:free
frames: AGENT_REGISTER, RESPONSE
retry transitions: 0
```

## Fault — a throttled slug (`openrouter/google/gemma-4-31b-it:free`, 429 at the provider)

```
bus: /var/folders/gs/n3wt6k6j2pg2l96hbw2fr5yr0000gr/T/fault-inject-tByaJ3/run-details/bus.sock
model: openrouter/google/gemma-4-31b-it:free
waiting up to 90s…

   0.0s  AGENT_REGISTER   {"agentId":"probe","title":"probe","model":"openrouter/google/gemma-4-31b-it:free","permissions":{"read":true,"edit":false,"shell":false},"maxCostUsd":1,"systemPrompt":"You are a probe. When asked, reply with the single 
   0.0s  -> PROMPT sent
   1.0s  HEARTBEAT.retry  RETRY 1/3
  16.1s  HEARTBEAT.retry  RETRY 2/3
  46.1s  HEARTBEAT.retry  RETRY 3/3

(timeout — nothing reached the bus)

=== summary ===
model: openrouter/google/gemma-4-31b-it:free
frames: AGENT_REGISTER
retry transitions: 3
     1.0s  RETRY 1/3
    16.1s  RETRY 2/3
    46.1s  RETRY 3/3
```

## What this settles

- **RT-10's retry setting works, live.** A real provider failure produced agent-level
  retries at **1.0 s, 16.1 s, 46.1 s** — the 15 s -> 30 s -> 60 s exponential cadence
  (`baseDelayMs: 15000`, cap 60000) that RT-10 specified. Before this, three task runs had
  never seen a transient provider error at all, so the fix was armed but unobserved.
- **F2 is confirmed live, not inferred.** Every retrying beat carried
  `retry: { attempt, maxAttempts }` with `progressed: false` for the whole window. Before F2 those events were
  `progressed: true` on every beat, which reset the stall clock forever — the supervisor
  could not be woken no matter how long the peer produced nothing.
- **The new observability works end to end**: the peer's `auto_retry_start` reached the bus
  as `HEARTBEAT.retry` and is what the runtime turns into a `RETRY` log entry.
- **Recovery is still unproven.** This slug fails permanently, so all three attempts failed by
  design; what is verified is that the retries fire, not that one recovers a transient error.
  Producing that needs a provider that fails once and then succeeds.
