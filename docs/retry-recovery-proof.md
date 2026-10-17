# Proving retry RECOVERY (attempt 1 fails, attempt 2 answers)

Research for issue #5. Question: what is the cheapest *faithful* way to show that pi's
agent-level provider retry actually recovers, in this repo's peer harness — not merely that
retries fire.

## 1. Verdict

Build one seam: extend `scripts/fault-inject.ts` to start a **loopback passthrough proxy** and
point the peer's `openrouter` provider at it through a **throwaway `PI_CODING_AGENT_DIR`** whose
`models.json` sets `providers.openrouter.baseUrl`. The proxy answers call #1 with HTTP 500 (a
text pi classifies as retryable) and streams call #2 to the real upstream with the real
credential, so the second attempt is an authentic provider response, not a canned one.
This is faithful because every layer that matters in production stays live: `peer-main` →
`PeerSession` → `AgentSession._handlePostAgentRun` → `_prepareRetry` → backoff → re-request →
`auto_retry_end(success)` → `HEARTBEAT.retry` cleared → one `RESPONSE`.
Everything cheaper is theatre: a stub peer never enters the retry path, and a
`pi.registerProvider` baseUrl override or a `before_provider_request` throw both fail for
source-level reasons proven in §2/§3. No `src/` change is needed, and no full `just task` run:
`just fault <slug> 90` is enough.

## 2. What is proven today vs not

Proven (existing evidence, `docs/evidence/fault-injection-2026-10-14.md`):

- F1 A real peer + real bus + a permanently failing slug produces three retries at 1.0/16.1/46.1 s
  and never a `RESPONSE` (`docs/evidence/fault-injection-2026-10-14.md:42-64`).
- F2 The retry is visible on the bus as `HEARTBEAT.retry {attempt,maxAttempts}` and the script's
  own transition tracker prints it (`scripts/fault-inject.ts:66-77`); the schema accepts it
  (`src/contracts/a2a-schema.ts:144-149`).
- F3 The peer's session surfaces `auto_retry_start` / `auto_retry_end` into that heartbeat payload
  (`src/peer/peer-session.ts:143-147`, cleared at `:150-153`), and `peer-main` publishes it on the
  1 s beat (`src/peer/peer-main.ts:121-141`).
- F4 The runtime turns a changed retry key into a `RETRY` log entry
  (`src/runtime/runtime.ts:739-748`) — only in a full task run.
- F5 pi supports agent-level retry as a **settings** feature, not a peer-config one:
  `retry.enabled|maxRetries|baseDelayMs|maxAgentDelayMs` (`docs/settings.md:125-131`), defaults
  `true / 3 / 2000 / 60000` (`dist/core/settings-manager.js:673-688`).
- F6 Cadence math: `baseDelayMs * 2^(attempt-1)`, capped at `maxAgentDelayMs` (default 60 s)
  (`@earendil-works/pi-ai/dist/utils/retry.js:93-98`). With
  `~/.pi/agent/settings.json` → `retry: {enabled:true, baseDelayMs:15000, maxRetries:3}`
  the delays are exactly 15 s / 30 s / 60 s, i.e. the observed 16.1 s and 46.1 s gaps are
  15 s + latency and +30 s. The repo doc's claim is therefore correct, and now source-confirmed.
- F7 Retry happens *inside one* `prompt()` run: `_handlePostAgentRun` → `_prepareRetry` →
  `agent.continue()` (`dist/core/agent-session.js:1417-1428`, `:3031-3045`), so a recovered turn
  yields one non-empty report on the harness's first attempt — the harness-level retry in
  `runPromptWithRetry` (`src/peer/peer-harness.ts:205-220`) is not involved.
- F8 A failed attempt is retryable only if the error text matches pi's pattern list, which
  contains `500`, `503`, `429`, `overloaded`, `timeout`, … (`pi-ai/dist/utils/retry.js:23-92`);
  non-retryable quota/billing text is excluded (`:4-21`). HTTP statuses reach that text because
  `formatProviderError` renders `"<status>: <body>"` (`pi-ai/dist/utils/error-body.js:111-121`).

Not proven today: that any attempt ever *succeeds*. The existing fault slug fails permanently by
construction (`docs/evidence/fault-injection-2026-10-14.md:78-80`). Nothing in the repo currently
produces "attempt 1 error, attempt 2 non-empty report".

## 3. Candidate shims

| # | Mechanism | Fidelity | Effort | Cannot prove |
|---|---|---|---|---|
| C1 | **Loopback proxy + `models.json` `providers.openrouter.baseUrl` override in a temp `PI_CODING_AGENT_DIR`** | High: real peer, real pi session, real provider metadata, real credential, real upstream on attempt 2. Only the transport peer is local | ~70 lines in `scripts/fault-inject.ts`, no `src/` change | Nothing about the *supervisor's* view (`final.md`, `RETRY` log, stall clock) unless a full task run is also done |
| C2 | `pi.registerProvider("openrouter",{baseUrl})` from an extension factory | **Not faithful — ineffective.** `peer-main` resolves `model` from `ModelRuntime` at module top level (`src/peer/peer-main.ts:49-56`) *before* `createSession()` runs `loader.reload()` (`:150-171`); the composer builds **new** model objects when the provider is recomposed (`dist/core/provider-composer.js:167-171`), so the object already captured keeps the real `baseUrl` and `streamSimple` reads `model.baseUrl` (`pi-ai/dist/api/openai-completions.js:560`) | medium | Would prove nothing; the 500 would never be sent |
| C3 | `before_provider_request` extension hook that throws | **Not faithful — ineffective.** Handler throws are caught and reported as extension errors, payload continues unchanged (`dist/core/extensions/runner.js:1066-1090`) | low | Cannot fail a call at all |
| C4 | Local HTTP proxy via `models.json` baseUrl, second call answered from a canned SSE body | Medium: proves the retry loop recovers, but the "success" is not a provider response | ~50 lines | That the recovered response is a real model answer; usage/cost realism |
| C5 | Stub peer process emitting `RESPONSE` on the bus without pi | **Theatre.** Bypasses `PeerSession`, `AgentSession`, `_prepareRetry` entirely (`src/peer/peer-session.ts:126-184`) | low | Retry semantics, `HEARTBEAT.retry`, `AGENT_UNUSABLE` |
| C6 | Full `just task` run with a proxy wired into the spawned pane | Highest end-to-end fidelity (writes `conversation.jsonl` `RETRY` entries and `final.md`) | high: needs herdr, panes, a supervisor model, a work order, and the temp agent dir exported into the pane (`src/runtime/runtime.ts:350-353` builds `bun … --config`) | Cheapness. Also risks poisoning the supervisor's own retry behaviour if the env var leaks to the supervisor |

Existing pi helpers: none. The installed package ships no fault-injection or mock-provider
utility (`examples/extensions/` has `provider-payload.ts` for observing payloads, nothing that
fails a call); `docs/custom-provider.md:162-173` only recommends testing a provider manually.

## 4. Recommended design (C1)

Change exactly one file: `scripts/fault-inject.ts` (the recipe already forwards model + timeout:
`justfile:30-32`).

Failure-injection point: **the HTTP request**, not the SDK, not the process. Exactly **one** call
fails; call #2 and later are streamed verbatim to the real upstream.

Config keys involved:

- `PI_CODING_AGENT_DIR` (documented `docs/environment-variables.md:81`; resolved by
  `getAgentDir()` in `dist/config.js:491-497`) — all three of `settings.json`, `models.json`,
  `auth.json` are read from it (`dist/config.js:502-513`), and `ModelRuntime.create` reads
  `join(getAgentDir(),"models.json")` (`dist/core/model-runtime.js:80`), i.e. **before**
  `peer-main` resolves the model.
- temp `models.json`: `{"providers":{"openrouter":{"baseUrl":"http://127.0.0.1:<port>/api/v1"}}}`
  — a provider entry with only `baseUrl` rewrites the URL on every existing chat model and keeps
  the catalog metadata and the provider's credential (`dist/core/provider-composer.js:167-171`;
  documented form in `docs/models.md:45-64`).
- temp `settings.json`: `{"retry":{"enabled":true,"baseDelayMs":15000,"maxRetries":3}}` (copy of
  the live global block) so the 15/30/60 cadence is the same one the incident evidence measured.
- `retryMaxRetries` in the peer config (`scripts/fault-inject.ts:39-40`) is set to **0** so a
  second *harness* turn can never be mistaken for the agent-level retry.

Second call answered by: forwarding to `https://openrouter.ai/api/v1` (the real production
`baseUrl`, `pi-ai/dist/providers/openrouter.js:11-13`) with the request's own headers, i.e. the
real `Authorization` from the real `auth.json`; the proxy never touches secrets.

```ts
// SKETCH — additions to scripts/fault-inject.ts. Not applied.
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { symlink } from "node:fs/promises";

const UPSTREAM = "https://openrouter.ai/api/v1";
let calls = 0;
const proxy = createServer((req, res) => {
  calls += 1;
  console.log(`proxy call#${calls} ${req.method} ${req.url}`);
  if (calls === 1) {
    // "500" matches pi's retryable pattern list -> agent-level retry is scheduled.
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fault-inject: 500 simulated upstream failure" } }));
    return;
  }
  const upstream = httpsRequest(
    new URL(UPSTREAM + (req.url ?? "/")),
    { method: req.method, headers: req.headers },   // Authorization rides along
    (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
  );
  upstream.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(upstream);
});
await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
const port = (proxy.address() as { port: number }).port;

const agentDir = join(dir, "agent");
await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, "models.json"),
  JSON.stringify({ providers: { openrouter: { baseUrl: `http://127.0.0.1:${port}/api/v1` } } }));
await writeFile(join(agentDir, "settings.json"),
  JSON.stringify({ retry: { enabled: true, baseDelayMs: 15000, maxRetries: 3 } }));
await symlink(join(homedir(), ".pi", "agent", "auth.json"), join(agentDir, "auth.json"));

const child = spawn("bun", ["src/peer/peer-main.ts", "--config", join(dir, "peer-config.json")], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },   // <-- the only wiring
});
```

`peer-config.json` keeps `model: <argv slug>` unchanged (`scripts/fault-inject.ts:30-41`), so the
slug stays `openrouter/...` and the real provider metadata (cost, context window, api
`openai-completions`) is what pi uses.

## 5. The run

No full `just task` run. One command, ~20 s:

```
just fault openrouter/cohere/north-mini-code:free 90 2>&1 | tee /tmp/retry-recovery.log
# equivalently: bun scripts/fault-inject.ts openrouter/cohere/north-mini-code:free 90
```

Artifacts to capture (all from that one log): the `proxy call#1 … / call#2 …` lines, the
`HEARTBEAT.retry` transitions, the single `RESPONSE` frame with non-zero `usage.tokens`, and the
script's `=== summary ===` block. Keep `--no-shim` as an escape hatch for the old
permanent-failure behaviour.

Model for the success half (Q3): `openrouter/cohere/north-mini-code:free` — present in the
installed catalog with real metadata (`cost 0/0/0/0`, `contextWindow 256000`,
`maxTokens 64000`), real credential path (`openrouter` key exists in `~/.pi/agent/auth.json`;
provider auth is `envApiKeyAuth(["OPENROUTER_API_KEY"])` + OAuth,
`pi-ai/dist/providers/openrouter.js:11-25`), and it already answered `PONG` in 1.2 s in the
control run (`docs/evidence/fault-injection-2026-10-14.md:7-40`). Second choice:
`deepseek/deepseek-flash` (openai-completions, key present, `pi-ai/dist/providers/deepseek.js:9-12`)
— paid, so only if the free slug is throttled. `openrouter/google/gemma-4-31b-it:free` is the
wrong choice here: it is the permanently-throttled slug from the original evidence.

## 6. Evidence format

New note `docs/evidence/retry-recovery-<date>.md`, same skeleton as
`docs/evidence/fault-injection-2026-10-14.md:1-6,42-46,66-80`:

- `# Retry recovery — attempt 1 fails, attempt 2 answers (<date>)`
- one-paragraph setup: shim type (loopback proxy), slug, timeout, that the second call went to the
  real upstream, and the retry settings block in force.
- `## Run` — verbatim console block: `bus:`, `model:`, `waiting up to Ns…`, then the timed lines
  (`0.0s AGENT_REGISTER`, `0.0s -> PROMPT sent`, `proxy call#1 …`, `~1.0s HEARTBEAT.retry RETRY
  1/3`, `proxy call#2 …`, `~16.xs retry cleared (recovered or turn ended)`, `RESPONSE {... "text":
  "PONG", "usage": {...}}`), then `=== reached the bus ===` and `=== summary ===` with
  `frames:` and `retry transitions:`.
- `## What this settles` — bullets, each naming the frame or call that proves it:
  attempt 1 failed (proxy call #1 → 500), the retry was pi's agent-level retry and not the
  harness's (`retryMaxRetries: 0`, single RESPONSE, `RETRY 1/3` at ~1 s), the delay matched
  `baseDelayMs` (observed gap ≈ 15 s), attempt 2 answered (proxy call #2 → 200 + response text +
  non-zero token usage), the retry cleared (`HEARTBEAT.retry` absent afterwards), and no
  `AGENT_UNUSABLE`/`FINAL_REPORT` was emitted.
- `## What this does not settle` — supervisor-side artifacts: no `conversation.jsonl` `RETRY`
  entry (`src/runtime/runtime.ts:739-748`), no `final.md` (`src/artifacts/final-writer.ts:37`),
  no stall-clock behaviour; those need a task run.

## 7. Risks and UNVERIFIED items

- R1 **pi may not send the chat request first through the proxy** (catalog refresh, cache warm).
  Check: the `proxy call#1` line must be `POST …/chat/completions`. Mitigation: any earlier proxy
  call increments the counter, so count failures by status, not by ordinal, if a preflight appears.
  UNVERIFIED that no preflight occurs: `ModelRuntime.create` refreshes over the network only with
  `allowModelNetwork === true` (`dist/core/model-runtime.js:95`), and `peer-main` passes no options
  (`src/peer/peer-main.ts:49`), which suggests no provider-side preflight.
- R2 **Cache warming** could issue an extra request (`cacheWarming` defaults to `"streaming"`,
  `docs/settings.md:19`). Check: extra `proxy call#` lines after the `RESPONSE`. It warms only for
  models that declare `promptCache` (cache-warmer gate in `dist/core/cache-warmer.js`); the chosen free
  model declares none, so warming stays inactive.
- R3 **Free-tier throttle on attempt 2** turns the run into 2-of-3. Check: `RETRY 2/3` in the log;
  the note then claims "a later attempt answered", not "attempt 2 answered".
- R4 **Temp agent dir loses real settings** (defaults `baseDelayMs 2000`). Check: observed gap
  ≈15 s, not ≈2 s; the note must print the settings block it wrote.
- R5 **`auth.json` symlink assumption**: credential resolution reads `getAuthPath()`
  (`dist/config.js:507-509`). Check: a `401` would appear on call #2 if it were missed.
- R6 Whether a `500` *before any stream event* is treated identically to a mid-stream error —
  source says yes (`dist/core/agent-session.js:2978-2983` calls `isRetryableAssistantError` on the
  message, independent of when it failed). Confirmed by reading, not yet by run.
- R7 `registerProvider` ineffectiveness (C2) is derived from call order in
  `src/peer/peer-main.ts:49-56` vs `:150-171` plus object replacement in
  `dist/core/provider-composer.js:167-171`. Check that resolves it: log `model.baseUrl` inside
  `createSession` — it still prints the upstream URL.

## 8. Sources

Repo: `scripts/fault-inject.ts:5,18,30-41,66-77,80-100,103-107,115,125-128`;
`justfile:30-32,41,70`; `docs/evidence/fault-injection-2026-10-14.md:1-6,7-40,42-64,66-80`;
`src/peer/peer-main.ts:49-56,121-141,150-171,228`; `src/peer/peer-session.ts:126-184,143-153`;
`src/peer/peer-harness.ts:205-220,80`; `src/peer/peer-config.ts:8-52`;
`src/contracts/a2a-schema.ts:144-149`; `src/runtime/runtime.ts:216,350-353,739-748`;
`src/artifacts/final-writer.ts:37`; `src/pi/model-preflight.ts:29-40`;
`.mypi/jev-c2-gate/session.yaml:33-42,99`; `~/.pi/agent/settings.json` (retry block).

Installed pi (`/Users/afshin/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent`):
`docs/settings.md:16,125-131`; `docs/configuration.md:7-31`; `docs/environment-variables.md:81`;
`docs/models.md:45-64`; `docs/custom-provider.md:14-30,148-173`;
`dist/config.js:491-497,502-513`;
`dist/core/settings-manager.js:673-688,713-718`; `dist/core/agent-session.js:770-784,1417-1428,
2978-2983,3031-3045`; `dist/core/model-runtime.js:78-96,657-676`;
`dist/core/provider-composer.js:150-190`; `dist/core/extensions/runner.js:1066-1090`;
`dist/core/extensions/types.d.ts:1281-1349,1389-1410`;
`examples/extensions/provider-payload.ts:1-20`.
pi-ai (`…/pi-coding-agent/node_modules/@earendil-works/pi-ai`):
`dist/utils/retry.js:4-21,23-92,93-98,188-194`; `dist/utils/error-body.js:111-121`;
`dist/api/openai-completions.js:185-205,491-510,560`; `dist/providers/openrouter.js:11-25`;
`dist/providers/deepseek.js:9-12`; `dist/providers/data/openrouter.json`
(`chat:cohere/north-mini-code:free`, `chat:google/gemma-4-31b-it:free`).

No web URLs were needed; every claim above is from these files.
