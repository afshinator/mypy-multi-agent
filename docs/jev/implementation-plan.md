# Jev integration — implementation plan / todo

_Status: not started. Ordered so no code lands before its exploration and tests.
Companion: [`integration-map.md`](integration-map.md) (the triage this executes)._

## 0. Verified current state (no assumptions)

Checked in source before writing this list:

- `criteriaSatisfied` — `src/supervisor/finalization.ts:52-58`. Compares verdict
  **count** (`verdicts.length !== criteria.length`) and `result === "pass"`. Never
  compares criterion strings or sender. Called from the single success decision:
  `Runtime.runSucceeded` — `src/runtime/runtime.ts:422-431`, invoked at
  `runtime.ts:398`. The peer-attested verdicts come from
  `attested = criteria ?? this.peerCriteria` (`runtime.ts:388`), captured at
  `runtime.ts:798-801`.
- Verdict contract — `src/contracts/criteria.ts`: `CriterionVerdictSchema` =
  strictObject `{ criterion, result: "pass" | "fail", evidence }`; peer-side parser
  `parseCriteriaBlock` extracts a fenced ```json block.
- Bus trust boundary — `src/bus/message-validator.ts:classifyFrame` is
  **structural only** (JSON → envelope → payload schema). Policy applied in
  `src/bus/router.ts:routeFrame` (line ~24). **No payload-content screening
  exists anywhere.**
- Shell gate — `src/pi/tool-permissions.ts:19-23`: `canShell` returns
  `(p.shellAllowlist ?? []).includes(command)` for `shell:true, edit:false`.
  `Templates/spec-plan-adversarial.yaml:156-162` declares `consistency_verifier`
  with `shell: true, edit: false` and **no `shell_allowlist`** → `[].includes(cmd)`
  is always false → zero command access. RT-8 defect D1, still open in
  `docs/TODO.md` “Next”.
- Guardrails — `test/integration/guardrails.test.ts` has exactly two describes
  (templates parse; Markdown links). It globs `templates/**/*.yaml` and
  **top-level `docs/*.md` only** (`readdirSync(join(repoRoot, "docs"))`), so
  `docs/jev/*.md` is not scanned. No “shell:true && edit:false ⇒ allowlist” test
  exists yet.
- Peer wiring — tools list from `toolsForPermissions`
  (`src/peer/peer-config.ts:59-66`); extensions assembled in
  `src/peer/peer-main.ts` (`extensionFactories: [permissionGate, toolCallLogger,
  changeNotifier, webTool]`); `PeerConfig`/`PeerPermissions` in
  `src/peer/peer-config.ts:9-30`. Supervisor tools registered via
  `pi.registerTool` in `src/pi/extension.ts:230-415`.
- Config — `src/contracts/session-schema.ts`: `PermissionsSchema` is a
  strictObject `{ read, edit, shell }`; `shell_allowlist` is a **separate
  agent-level field**; `SessionSchema` is a strictObject (new keys must be added
  explicitly).
- **No Jev code, dependency, or reference exists** (grep for `jev`/`typesafe`
  across `src/`, `test/`, `templates/`, `package.json` is empty). `package.json`
  deps: `@earendil-works/pi-coding-agent`, `typebox`, `yaml`, `zod`.

## 1. Explorations (do first — adoption depends on these)

- [ ] **E1 — Pin down the Jev API.** Auth (TypeSafe API key vs OpenRouter
      `~typesafe/jev-latest`), endpoint, request/response shape, whether the
      repo’s model registry / catalog already exposes it. Nothing in-repo
      documents this; the only source is `docs/jev/10_levels_of_jev_...md`.
      Output: a one-page note with a working raw call.
- [ ] **E2 — Measure latency, cost, and variance vs a supervisor model turn.**
      This is the “concrete run showing benefit” that R1 requires before C1/C2/C5
      can be adopted. Include: same-input-same-output check (is Jev stable enough
      to sit anywhere near the exit gate?).
- [ ] **E3 — Confirm the config threading path** for a new opt-in block:
      `session-schema.ts` (strictObject) → `SessionConfig` → `Runtime` constructor
      options (mirrors how `stall_timeout_ms` / `verify_models` flow). Decide one
      namespaced block (`session.jev.*`) vs several flat keys.
- [ ] **E4 — Local-first check.** README states the system runs locally with “no
      cloud orchestration.” If Jev is a network API, document the tension and
      decide whether it disqualifies C1/C2 (engine-side) or is acceptable
      (agent-side, opt-in only).

## 2. Tests (write before the code they cover)

- [ ] **T1 — Keep the deterministic gate green.** `test/unit/finalization.test.ts`
      already covers `criteriaSatisfied`. Add explicit tests that the Jev layer
      is **veto-only**: it can hold a run for review, and can never flip
      `fail → pass` nor silently flip `pass → fail`.
- [ ] **T2 — `src/jev/criteria-check.ts` unit tests** against a stub client:
      all-pass + high confidence → pass; all-pass + low confidence → hold;
      any-fail → fail regardless of Jev confidence.
- [ ] **T3 — `src/jev/injection-gate.ts` unit tests** against a stub client,
      including the adopted **log-and-continue** policy: a flagged inbound frame
      is annotated and still delivered (never dropped).
- [ ] **T4 — `test/contracts/session-schema.test.ts`**: new opt-in key(s) parse,
      and **default to off**.
- [ ] **T5 — RT-8 D1 guardrail** in `test/integration/guardrails.test.ts`: assert
      every template agent with `shell:true && edit:false` declares a non-empty
      `shell_allowlist` (same shape as the existing “finds at least one in-repo
      relative link” self-check).
- [ ] **T6 — Integration**: an injection-flagged inbound envelope is logged with
      the flag and the run continues (`test/integration/`).

## 3. Implementation

- [ ] **I1 — RT-8 D1, deterministic, no Jev (prerequisite).** Add the
      `consistency_verifier` `shell_allowlist` in
      `templates/spec-plan-adversarial.yaml` (or set `shell: false` and rename the
      role honestly). Ship T5 with it.
- [ ] **I2 — `src/jev/client.ts`**: thin client for E1’s confirmed API. No
      behaviour beyond transport + typed response.
- [ ] **I3 — C1, semantic verdict check (veto-only).** `src/jev/criteria-check.ts`
      returns a confidence signal. Wire it **beside** `runSucceeded`
      (`runtime.ts:422`), not inside `criteriaSatisfied` (keep that pure and
      deterministic). Low confidence ⇒ hold finalization for supervisor review;
      attach the signal to `final.md`. Opt-in, default off.
- [ ] **I4 — C2, peer→supervisor injection gate.** `src/jev/injection-gate.ts`
      screens valid inbound frame **content**; log-and-continue only. Wire it at
      the runtime inbound handling path, after structural validation. Opt-in,
      default off. Threshold is a config value, not a constant.
- [ ] **I5 — Config block** from E3, plus template/doc comments.
- [ ] **I6 — C7, `ask_jev` tool** (gated on E2 evidence). Three edits:
      `session-schema.ts` opt-in flag (peer permission, mirroring
      `read`/`edit`/`shell`), registration in `src/peer/peer-main.ts`
      (peers) and `src/pi/extension.ts` (supervisor), instruction text in
      `supervisor-prompt.md` + the relevant `templates/*.yaml` `system_prompt`.
- [ ] **I7 — C5, opt-in pre-flight** (gated on E2 + a run that shows the
      supervisor burning budget on triage). Session-level flag; diff-risk wiring.
      Lowest priority.
- [ ] **I8 — Docs**: update `integration-map.md` verdicts and the README/spec
      status line.

## 4. Deferred / rejected (recorded, not built)

- **C3-upgrade (semantic shell intent) — deferred** until I1 lands, then
  evaluated as *suggestion only*, never the gate: regex is fail-closed, Jev is
  fail-open, so Jev must not be the safety boundary (see R3).
- **C4 (frame classification) — rejected**: `classifyFrame` is deterministic and
  correct; Jev adds nothing.
- **C6 (confidence-floored thresholds) — rejected**: flat thresholds have not
  failed for any observed reason.

## 5. Open questions

- **Q1** (from E2): is Jev stable enough (same input → same decision) to sit
  anywhere near the exit-0/1 gate, even as a veto?
- **Q2** (from E4): does a network Jev violate the project’s local-first stance
  for engine-side use?
- **Q3**: does a Jev call count against `usage-accounting` / the session budget,
  or is it out-of-band? Decide before I3/I4.
- **Q4**: should the guardrails Markdown-link test be widened to `docs/**/*.md`
  (it currently skips `docs/jev/`)?

## 6. Risks

- **R1 — probabilistic output at the exit gate.** Mitigation is structural:
  `criteriaSatisfied` stays the deterministic hard gate; Jev is veto/scrutiny
  only, opt-in and default off. If Q1 says Jev is unstable, C1 degrades to a
  `final.md` annotation, not a gate.
- **R2 — local-first.** Engine-side Jev (I3/I4) is the tension; keep it opt-in
  and default-off until E4 resolves it.
- **R3 — fail-open safety.** Never let Jev be the sole decider of a destructive
  action (this is why C3-upgrade is suggestion-only).

---
_Critical: do not start I3/I4 before E1 and E2. Wiring a probabilistic model into
`runtime.ts` success/failure with an unverified API is how the deterministic exit
contract (spec G4) silently breaks._
