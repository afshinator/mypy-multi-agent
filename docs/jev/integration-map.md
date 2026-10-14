# Jev × mypy-multi-agent: integration map

_Status: C1 adopted and shipped as an advisory (2026-10-13); C3's hole fixed
deterministically; C5/C7 still candidates. Each candidate is triaged against
one question: **does it fix a hole, deliver a clear upgrade, or is it
Jev-for-its-own-sake?** Forced uses get rejected or parked._

Source material: [`10_levels_of_jev_for_agentic_engineers.md`](10_levels_of_jev_for_agentic_engineers.md).

## How to read this document

Every candidate answers the same three questions, so "where does Jev actually
help" is a filter, not a reading exercise:

1. **Problem** — the hole it closes or the concrete pain it removes.
2. **Why Jev, not the existing code** — what deterministic code cannot do here.
3. **Verdict** — `adopt` (real hole + Jev is the right tool), `candidate`
   (plausible upgrade, needs more evidence), or `forced` (works, but only
   exercises Jev — reject).

Skip any row whose `Verdict` is `forced`. That is the answer to "where does it
apply."

## Two integration surfaces (context, not the axis)

- **Core engine** — deterministic TS (`runtime/`, `bus/`, `budget/`,
  `validation/`, `peer/permission-gate.ts`). Where "code calls Jev" (Levels 1–7)
  lands.
- **Agents** — pi instances (`supervisor-prompt.md` for the supervisor,
  `system_prompt` in `session.yaml` for peers). Where "agent calls Jev"
  (Levels 8–10) lands.

Levels 1–7 are engine-only. Levels 8–10 are engine-registered tools
(`src/pi/extension.ts` for the supervisor, `src/peer/peer-harness.ts` for peers)
plus a prompt instruction — the yaml `system_prompt` alone cannot call Jev.

## Candidates

### C1 — Semantic DoD-verdict check (Jev L1/L2)

- **Problem:** `criteriaSatisfied` (`src/supervisor/finalization.ts:52-58`)
  counts flags, not meaning — RT-8 defect #2. It checks `verdicts.length ===
  criteria.length` and every `result === "pass"`, never the criterion string or
  sender. A fabricated but well-formatted verdict reaches exit 0. The
  deterministic fix needs a contract change (per RT-8); no code in the repo can
  judge whether a verdict actually addresses its criterion.
- **Why Jev:** semantic judgment is the one thing the deterministic layer
  structurally cannot do.
- **Verdict: `adopt` — shipped 2026-10-13 as an advisory** (`src/jev/verdict-advisory.ts` +
  `extension.ts`), never a gate. The deterministic half shipped too: `criteriaSatisfied` now matches
  criterion strings verbatim and only trusts `session.attester` (RT-8 D2/A1). See R1 — measured
  variance makes a probabilistic gate unusable.

### C2 — Peer→supervisor prompt-injection gate (Jev L1)

- **Problem:** `src/bus/message-validator.ts` validates envelope structure, not
  payload *content*. A peer's report/prompt text is fed into the supervisor's
  context with no semantic screening — a malicious or drifted peer can inject
  instructions. Regex cannot detect injection; this is Jev's canonical L1 use
  case.
- **Why Jev:** semantic classification; no deterministic equivalent exists.
- **Verdict: ship/adopt — shipped 2026-10-14 as a non-gating annotation gate** (`src/contracts/session-schema.ts:47-52` + `src/runtime/runtime.ts:731` + `src/pi/extension.ts:523-532` + `src/jev/injection-gate.ts:189-196`): implemented scope is the gate's screenInboundFrame pipeline; decisions are (a) classifier error flags the frame rather than passing it (fail-closed on an unresolved slug / classifier error) and (b) `injection_check` is the only total off-switch.

### C3 — Semantic shell-command gating (Jev L6/L3)

- **Problem:** two distinct things, keep them separate:
  - *Hole:* `shell: true, edit: false` with no `shell_allowlist` silently grants
    zero command access (`src/pi/tool-permissions.ts:19-23`) — RT-8 defect #1.
  - *Upgrade:* the allowlist itself is exact-match regex, so "destructive vs
    read-only" is judged by string match, not intent.
- **Why Jev:** only the *upgrade* half. Jev classifies command intent
  (read_only / reversible / irreversible) semantically, which regex can't. It
  does **not** fix the hole — that is a one-line allowlist/config fix, no Jev.
- **Verdict:** the *hole* is **fixed** (2026-10-13, `d05b7cd`): a schema rule rejects
  `shell: true, edit: false` with no runnable set, and `session.shell_vocabulary` supplies one list
  inherited by every read-only shell peer. The *upgrade* (semantic intent) stays `candidate` — never
  the gate: regex is fail-closed, Jev is fail-open.

### C4 — Frame classification (Jev L1/L2)

- **Problem:** `src/bus/malformed-counter.ts` already counts malformed frames
  deterministically. No hole here — the classification is structural and correct.
- **Why Jev:** none. It would only re-derive what the parser already decides.
- **Verdict:** `forced` — reject.

### C5 — Diff risk-scoring / test-failure triage (Jev L5)

- **Problem:** no risk scoring exists today; the supervisor triages from raw
  context. This is an *upgrade* (cheaper pre-dispatch triage), not a hole.
- **Why Jev:** cheap ~300ms pre-flight vs a full peer turn.
- **Verdict:** `candidate` — plausible upgrade, lowest priority; no current pain
  forces it.

### C6 — Confidence-floored thresholds (Jev L3)

- **Problem:** `src/budget/budget-enforcer.ts` and
  `src/runtime/heartbeat-monitor.ts` use flat hard-coded thresholds. Flat
  thresholds are not broken; nothing observed has failed because of them.
- **Why Jev:** none that fixes a real problem.
- **Verdict:** `forced` — reject.

### C7 — `ask_jev` tool for supervisor/peers (Jev L8–L10)

- **Problem:** none that the agent cannot already express. This is a capability
  add, not a fix.
- **Why Jev:** gives agents cheap probabilistic sanity checks on demand.
- **Verdict:** `candidate` — adopt only if a concrete run shows the agent
  burning budget on decisions Jev answers for a fraction of a cent. No such run
  yet.

## Risk

### R1 — Probabilistic output vs explicit completion semantics

Folding Jev into `criteriaSatisfied` (the exit-0/1 gate) makes finalization
non-deterministic, fighting spec G4 and the deterministic test suite. Measured
(E2): ~0.03 probability spread on identical input, so C1 shipped **advisory
only** — it can never change `exit_code`; the gate stays deterministic. C2 shipped non-gating (annotate-only, exit code unchanged) like C1: classifier error flags frames (fail-closed on unresolved slug / classifier error, `src/runtime/runtime.ts:731` and `src/pi/extension.ts:523-532` and `src/jev/injection-gate.ts:189-196`) and `injection_check` is the only total off-switch (`src/contracts/session-schema.ts:47-52`).
