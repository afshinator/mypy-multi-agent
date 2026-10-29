# Jev integration — implementation plan / todo

_Status: E1–E4 done. C1 shipped (advisory, 2026-10-13); C2 shipped (non-gating,
2026-10-14); C5/C7 candidates.
Companion: [`integration-map.md`](integration-map.md) (the triage this executes)._

## 0. Verified state at writing (2026-10-13)

**Since then:** `criteriaSatisfied` compares criterion identity, not just pass flags,
and only `session.attester`'s block is captured (RT-8 D2/A1; rendering folded per
#118); `Runtime.runSucceeded` is now `Runtime.gateResult`; payload-content screening
exists (`src/jev/injection-gate.ts`, called from `Runtime.dispatchFrame`), so the
"no payload-content screening anywhere" line below is history; `src/jev/` and
`test/integration/injection-gate.test.ts` exist; `guardrails.test.ts` has three
describes, not two.

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
  is always false → zero command access. RT-8 defect D1 (fixed; see the GitHub issue tracker).
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

- [x] **E1 — Jev API pinned down.** API is `runtime.classify(model, { state, questions })`
  (SDK `ModelRuntime`/`ModelRegistry`; extensions also via `ctx.modelRegistry.classify()`).
  Auth lives in `~/.pi/agent/auth.json` (`opencode`, `openrouter`, `commandcode` present).
  Four Jev classifiers are exposed: `opencode/jev-1.13` (32K), `opencode/jev-1.13-free` (32K),
  `openrouter/~typesafe/jev-latest` (64K), `openrouter/typesafe/jev-1.13` (64K).
  **`opencode/jev-1.13` (paid) returns 402 insufficient funds** — credentials are not funds, so
  `getAvailableOfType` overstates usability. The `-free` variant and both OpenRouter slugs work.
- [x] **E2 — Latency, cost, variance measured** (5 runs/variant). Latency 170–870 ms:
  `openrouter/typesafe/jev-1.13` ~170–190 ms (fastest), `opencode/jev-1.13-free` ~400–870 ms.
  Cost: `opencode/jev-1.13-free` = $0; OpenRouter ≈ $0.0000155/call (393 tokens).
  **Variance: not deterministic** — identical input returned bool probabilities 0.57–0.60
  (opencode) and 0.57–0.59 (OpenRouter), ~0.03 spread. Injection probe returned p=0.99 on an
  embedded instruction (correct). Decision implication: usable only with a wide threshold
  margin; a threshold near the mean flips run to run.
- [x] **E3 — Config threading done.** One namespaced block, `session.jev:
      { verdict_check, model, review_threshold }` (`session-schema.ts`); the
  extension reads it and threads the advisory through `Runtime.finalize`.
- [x] **E4 — Local-first: tension confirmed.** Jev is a network call (OpenCode / OpenRouter).
  Decision (opt-in + default-off, or disqualify) still open.

## 2. Tests (write before the code they cover)

- [x] **T1 — Gate kept green.** The advisory cannot touch the exit code:
  `test/integration/artifacts.test.ts` drives `finalize` with an all-flagged
  advisory and asserts `exit_code: 0`. (C1 shipped advisory-only, not a veto,
  so there is no hold path to test.)
- [x] **T2 — Superseded.** No `criteria-check.ts`: the logic is
  `src/jev/verdict-advisory.ts` with `test/unit/verdict-advisory.test.ts`
  (flag below threshold; a failed call → flagged/unknown) and
  `test/unit/jev-advisory.test.ts` (glue against a fake registry).
- [x] **T3 — done.** `test/unit/injection-gate.test.ts` covers the gate against
  a stub classifier: threshold equality, timeout (and `injection_timeout_ms: 0`
  meaning no timeout), non-`Error` throws floored to "classifier error",
  NaN/out-of-range scores flagged with a null score, and log level/event per
  decision. `test/integration/injection-gate.test.ts` covers the
  log-and-continue wiring: annotated and still delivered, never dropped.
- [x] **T4 — Done.** `session.jev` parses with its defaults (`verdict_check`
  defaults false) and is covered by the schema tests.
- [x] **T5 — RT-8 D1 guardrail.** Shipped in `d05b7cd`, stronger than planned: a schema rule
  rejects `shell: true, edit: false` with no runnable set, so the existing template-parse test
  enforces it on every template (canary-proven — removing an allowlist fails the test). No
  separate `guardrails.test.ts` assertion added.
- [x] **T6 — done.** `test/integration/injection-gate.test.ts`: an
  injection-flagged inbound envelope is logged with the flag and the run
  continues.

## 3. Implementation

- [x] **I1 — RT-8 D1 fix shipped** (`d05b7cd`, no Jev). `spec-plan-adversarial`
  `consistency_verifier` → `shell: false`; `tdd-build` `test_verifier` → its declared checks;
  `session.shell_vocabulary` added; schema rule + tests.
- [x] **I2 — Superseded.** No client file: the classifier call is inlined in
  `extension.ts` (`jevAdvisory`), which already holds `ctx.modelRegistry`.
- [x] **I3 — C1 shipped as an advisory, not a veto** (`src/jev/verdict-advisory.ts` + `extension.ts`).
  Decided: A1 (deterministic criterion-identity + attester gate) is the gate; C1 is advisory only.
  Computed in the extension via `ctx.modelRegistry.classify`, attached to `final.md` and the
  `finalize` tool result; it never changes the exit code. Default off.
- [x] **I4 — C2 shipped** (2026-10-14).
  `src/jev/injection-gate.ts#screenInboundFrame` screens valid inbound frame
  **content**; log-and-continue only, called from `Runtime.dispatchFrame` after
  structural validation. Opt-in, default off; the threshold is
  `session.jev.injection_threshold`.
- [x] **I5 — Config block shipped:** `session.jev: { verdict_check, model, review_threshold }`,
  plus template/guide comments.
- [ ] **I6 — C7, `ask_jev` tool** (gated on E2 evidence). Three edits:
  `session-schema.ts` opt-in flag (peer permission, mirroring
  `read`/`edit`/`shell`), registration in `src/peer/peer-main.ts`
  (peers) and `src/pi/extension.ts` (supervisor), instruction text in
  `supervisor-prompt.md` + the relevant `templates/*.yaml` `system_prompt`.
- [ ] **I7 — C5, opt-in pre-flight** (gated on E2 + a run that shows the
  supervisor burning budget on triage). Session-level flag; diff-risk wiring.
  Lowest priority.
- [x] **I8 — Docs synced** (2026-10-13): the `integration-map.md` C1/C3 verdicts
  and this ledger are updated. No README/spec Jev status line exists.

## 4. Deferred / rejected (recorded, not built)

- **C3-upgrade (semantic shell intent) — deferred** until I1 lands, then
  evaluated as _suggestion only_, never the gate: regex is fail-closed, Jev is
  fail-open, so Jev must not be the safety boundary (see R3).
- **C4 (frame classification) — rejected**: `classifyFrame` is deterministic and
  correct; Jev adds nothing.
- **C6 (confidence-floored thresholds) — rejected**: flat thresholds have not
  failed for any observed reason.

## 5. Open questions

- **Q1 — answered (E2):** Jev is **not deterministic** (~0.03 probability spread on identical
  input). It cannot be part of the deterministic exit gate. Viable only as a veto with a wide
  threshold margin plus a deterministic fallback.
- **Q2** (from E4): does a network Jev violate the project’s local-first stance
  for engine-side use?
- **Q3 — answered:** classifier usage is returned in `result.usage` and pi adds it to the session
  cost (`models.md`). OpenRouter calls are billed (~$1.55e-5 each); `opencode/*-free` reports $0.
  Out-of-band for the budget enforcer unless we thread it in.
- **Q4 — answered:** yes, and it landed. `test/integration/guardrails.test.ts` now globs `docs/**/*.md` and
  checks documented code citations (`path#symbol` / `path:symbol`) against the tree.

## 6. Risks

- **R1 — probabilistic output at the exit gate.** Measured in E2: ~0.03 probability spread on
  identical input. Mitigation is structural: `criteriaSatisfied` stays the deterministic hard gate;
  Jev is veto/scrutiny only, opt-in and default off, with a threshold margin wider than the spread.
  If a threshold cannot be placed clear of the spread, C1 degrades to a `final.md` annotation.
- **R2 — local-first.** Engine-side Jev (I3/I4) is the tension; keep it opt-in
  and default-off until E4 resolves it.
- **R3 — fail-open safety.** Never let Jev be the sole decider of a destructive
  action (this is why C3-upgrade is suggestion-only).

---

_Critical: do not start I3/I4 before E1 and E2. Wiring a probabilistic model into
`runtime.ts` success/failure with an unverified API is how the deterministic exit
contract (spec G4) silently breaks._
