# Independent verification handoff — trace/correlation status

Repo: `afshinator/mypy-multi-agent`, HEAD `713aec4`. This is a checklist for an
independent verifier: every claim below has a location and a command to confirm or
refute it. Do not take the claims at face value — run the checks.

## Status at a glance (what is claimed)

1. **#21 fixed.** Turn durations pair by identity, not timestamp order. Issue CLOSED.
2. **Telemetry decision is v1.0.** OTel _data model_ adopted; no standing SDK. D1–D7
   authoritative.
3. **S3 oracle exists.** `docs/trace-semantics-oracle.md` defines the A1–A10 expected-
   execution-graph gate.
4. **S4 prototypes pass the oracle**, fields-only and OTel SDK, with real socket and
   real cross-process propagation. The oracle itself is mutation-tested (non-vacuous).
5. **D5 cleared for both; D6 resolved to fields-only** (commit `3a82783`); **S6 and the
   D3 envelope field shipped** (`src/tracing/`, `traceparent` on the strict-Zod
   envelope at `src/contracts/a2a-schema.ts:157`).

## Verification checklist

### 1. #21 turn-duration identity pairing

- Read `turnKey` and `turnDurations` in `shared/turn.ts` — `src/scorecard/scorecard.ts`
  only imports `turnDurations`. They must pair
  by `correlationId` (PROMPT/RESPONSE) and `taskId` (WORK_ORDER/FINAL_REPORT), and skip
  id-less entries.
- Read `log()` in `src/runtime/runtime.ts`. It must persist `correlationId` and stamp
  `taskId` (from `inFlightTaskIds`) onto FINAL_REPORT entries.
- Run:

  ```
  bunx vitest run test/unit/scorecard.test.ts test/integration/artifacts.test.ts
  ```

  Two red-first tests (`interleaved prompt turns…`, `mixed work-order and prompt…`) and
  one integration test (`persists correlationId and taskId…`) must pass.
- Confirm the issue state: `gh issue view 21 --json state` → `CLOSED`.

### 2. Telemetry decision v1.0

- Read `docs/telemetry-correlation-handoff.md`. D1 (data model) and D2 (no SDK/collector/
  egress) are settled; D4–D6 were the conditional path and D6 resolved to fields-only; D7
  (#21) is marked shipped.

### 3. S3 oracle

- Read `docs/trace-semantics-oracle.md`. It must define the span taxonomy (run-level vs
  work-order-level), the cross-process parent edge, and assertions A1–A10.

### 4. S4 prototype results — this is the self-reported part, re-run it

The evidence doc `docs/evidence/s4-bun-context-2026-10-19.md` is self-reported. The
probe that produced it is committed at `scripts/bun-s4-probe/`. Re-run it to verify
independently (Bun 1.4.2, macOS arm64):

```
cd scripts/bun-s4-probe
bun install          # @opentelemetry/api 1.9.1, @opentelemetry/context-async-hooks 2.12.0,
                     # @opentelemetry/core 2.12.0, @opentelemetry/sdk-trace 2.12.0
bun run main.ts      # in-process: fields-only + otel-sdk, each 17 spans, propagation 3/3, oracle 0 failures
bun run mutate.ts    # oracle mutation test: expected "18 passed, 0 missed"
bun run run2p.ts     # two-process: both strategies, propagation 3/3, oracle 0 failures
```

Re-run at `713aec4` (Bun 1.4.2, macOS arm64) reproduced all of it: `main.ts` 17 spans
per strategy, propagation 3/3, oracle 0 failures; `mutate.ts` 18 passed, 0 missed;
`run2p.ts` 17 spans per strategy across two processes, 0 failures.

## Gaps a verifier must weigh

- **A8 (span links) is only negative-tested.** The scenario has empty `justified_links`;
  the mutation test proves a fabricated link is rejected, but no legitimate-link case ran.
- **F2 scenario boundary.** One dispatch per task, no re-ask/retry/resume/abort. The
  oracle's A9/A10 bijection rules would need revision for general runs (stated in the
  oracle doc itself).
- **Version pin.** Bun 1.4.2/macOS arm64; re-run on a Bun bump.

## What is explicitly NOT decided

- General-run trace semantics: the A9/A10 bijection rules hold for the F2 scenario only
  (re-ask, retry, resume and abort are unmodelled).

Settled since this checklist was written, and no longer open questions: D6 selected
fields-only (`3a82783`), S6 shipped (`src/tracing/`), and `traceparent` is on the
strict-Zod envelope (`src/contracts/a2a-schema.ts:157`).

## Other open issues (context, not part of this verification)

`#41` (peer can't open a prompt) and `#10` are open; `#7` and `#6` were closed on
2026-10-21 without implementing what they describe (no `ask_jev` exists, and usage is
still booked per completed reply). None are part of the trace/correlation status above.
