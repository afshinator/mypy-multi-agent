# implementation-plan.md — C2 peer→supervisor injection gate: implementation and traceability plan

| Field | Value |
|---|---|
| Owner | `implementation_planner` (sole writer of this file) |
| Contract consumed | `DC-JEV-C2-GATE` v`1.1.0`, status `FROZEN` (`.mypi/spec-c2-gate/data-contracts.md` §0) |
| Task root | `.mypi/spec-c2-gate/` · branch `spec-c2-gate` (unmerged) |
| Evidence classes | `[exec-here]` command run in this workspace, raw output pasted · `[citation]` `path:line` + quoted text · `[reasoned]` named assumption, only where the other two are impossible |

---

## §0 Frozen contract consumption & non-authority rule

This document owns execution sequencing, module layout, milestones, traceability, and future build commands. It defines no local types, interfaces, schemas, aliases, config keys, or enum variants. All type names, config keys, record layouts, error derivation rules, and ordering rules are consumed verbatim from `DC-JEV-C2-GATE` v1.1.0 (`data-contracts.md` §0–§11, including `§Amendment 2026-10-13`).

[citation] `.mypi/spec-c2-gate/data-contracts.md:21-24` — "This contract is binding on `spec.md`, `ingestion-spec.md`, and `implementation-plan.md` (task root): those documents consume these field names, types, nullability, enums, IDs, and ordering verbatim and define no local schema variants."

---

## §1 Implementation items summary (A1–A12)

- **A1 (Config Schema Extension):** Add three additive rows inside `z.strictObject` in `src/contracts/session-schema.ts:41-47` (`JevSchema`): `injection_check: z.boolean().default(false)` (opt-in, default off), `injection_threshold: z.number().gt(0).lt(1).default(0.8)` (config threshold, not constant), and `injection_timeout_ms: z.number().int().gte(0).default(2000)` (`0` disables). Because `JevSchema` is a `z.strictObject`, sessions setting these keys today are rejected with `unrecognized_keys` until this delta lands (DD-4 opponent O1 resolution).
- **A2 (Gate Core Transformer):** Create `src/jev/injection-gate.ts` implementing `screenInboundFrame` with input assembly (`InjectionScreenInput`), per-field screening (`InjectionScreenResult`), and decision wrapping (`InjectionGateDecision` with `contractVersion: "1.1.0"`).
- **A3 (Deterministic Field Mapping):** Implement closed subset mapping in `src/jev/injection-gate.ts`: `"FINAL_REPORT" => "report"`, `"RESPONSE" => "text"`, returning `null` / bypassing all other 20 `EVENT_TYPES`.
- **A4 (Classifier-Error Fallback & Exact Error Derivation):** Implement DD-3 fallback in `src/jev/injection-gate.ts`: catch rejections, non-numbers, `NaN`/`Infinity`, out-of-range, and timeout errors, emitting `score: null, flagged: true, error: <derived string>` without throwing. Derive error via exact contract expression: `err instanceof Error && err.message !== "" ? err.message : String(err) !== "" ? String(err) : "classifier error"`.
- **A5 (Call-Site Timeout Race):** In `src/jev/injection-gate.ts`, wrap the `estimate` call in a `Promise.race` against `injection_timeout_ms` (when `> 0`). An unsettled promise converts to fallback error `"classify failed: timeout after <ms> ms"`. Timeout logic lives strictly at the gate call site and never inside any data record.
- **A6 (Comparator & Disjunction):** Implement DD-4 comparator: `flagged = score === null || score >= threshold` (stub-asserted with exact doubles, no epsilon), and frame-level disjunction `screens.some(s => s.flagged)` with "flagged wins".
- **A7 (Deterministic Output Ordering):** Implement contract §8 sorting in `src/jev/injection-gate.ts`: `screens` sorted by `ScreenedField` ordinal (`"report"` before `"text"`).
- **A8 (Async Per-Connection Inbound Serialization):** Update `src/runtime/runtime.ts:638-639` to make the `socket.on("data")` callback `async` and serialize frame dispatch through a per-connection promise chain, ensuring frame N+1 is not dispatched until frame N's gate promise settles. This preserves intra-connection arrival order and monotonic `at` timestamps (DD-1 opponent O1 resolution).
- **A9 (Runtime Inbound Insertion & Try-Containment):** Wire `src/runtime/runtime.ts` at line ~653 inside `if (env !== undefined)` and inside the existing `try` block (`runtime.ts:654-663`) to execute `screenInboundFrame` before `this.handleEnvelope(env, connId, socket)`.
- **A10 (Run Log Annotation):** Append `InjectionGateLogEntry` records to `ConversationLog` (`conversation.jsonl`) via `src/runtime/runtime.ts` with levels `"info"` (unflagged) and `"warn"` (flagged / classifier error).
- **A11 (Routing Contract Preservation):** Preserve DD-1: `routeFrame` returns unchanged `env`; flagged frames are annotated and still delivered; `routeFrame` valid/undefined contract is unchanged and never altered to return `undefined` or drop on flagged content.
- **A12 (Annotation Sink Scope & Envelope Schema Invariance):** Delivery to supervisor context is accomplished via `InjectionGateLogEntry` written to `conversation.jsonl`. Because `src/pi/extension.ts:569-570` extracts only payload prose (`p.text ?? p.report ?? ""`), threading decision annotations into supervisor prompt context is a separate integration concern; `A2AEnvelopeSchema` (`src/contracts/a2a-schema.ts:147`, a `z.strictObject`) must NOT be modified to carry annotation fields (DD-2 opponent surviving objection resolution).

---

## §2 Traceability Table A — DoD criteria (C1–C10) to implementation

Every DoD criterion is quoted verbatim from `.mypi/spec-c2-gate/run-details/plan.md` §5.

| # | DoD criterion (verbatim from `plan.md` §5) | Concrete implementation item(s) | Establishing check command / artifact | Evidence class |
|---|---|---|---|---|
| C1 | `data-contracts.md is a frozen, unambiguous canonical contract with exact types, nullability, enums, IDs and ordering, and no placeholder examples.` | Consumed verbatim in A1–A7; types imported directly from contract v1.1.0; zero local redefinitions. | `ls -l .mypi/spec-c2-gate/data-contracts.md && grep -nEi "TBD\|TODO\|FIXME\|<placeholder>\|xxx" .mypi/spec-c2-gate/data-contracts.md` | `[citation]` `data-contracts.md:10-13` (§0 Freeze header) |
| C2 | `spec.md covers every requested behaviour and acceptance check, bound to the canonical contract's exact names.` | Mapped to unit & integration test suites in Milestones M1–M4 validating AC-1 through AC-38. | `grep -c "AC-" .mypi/spec-c2-gate/spec.md` (returns ≥ 5; actual 59 total matches, AC-1..AC-38 numbered checks) | `[citation]` `spec.md` §10:587-641 (Acceptance checks table at lines 600-637) |
| C3 | `ingestion-spec.md / execution spec consumes the canonical fields verbatim with no local schema variant.` | Mapped to runtime wiring A8–A12 matching `ingestion-spec.md` §1 insertion point, serialization, and §5 step order. | `grep -nE "^(type\|interface\|schema) " .mypi/spec-c2-gate/ingestion-spec.md` (returns empty) | `[citation]` `ingestion-spec.md:16-28` (§0 consumed names table) |
| C4 | `implementation-plan.md maps every DoD criterion and source section to concrete modules, milestones, and future commands, with per-module YAGNI/smallest-solution notes.` | This document: §2 Table A (C1–C10), §3 Table B (sources), §4 Modules with YAGNI notes, §5 Milestones M1–M4, §6 Future Commands. | Read `.mypi/spec-c2-gate/implementation-plan.md` §2, §3, §4, §5, §6 | `[citation]` `plan.md` §5:72 (DoD C4 check) |
| C5 | `Every load-bearing decision has a recorded round in plan.md: the owner's falsifier pre-registered before the opponent reviewed, the opponent's FALSIFIER RESULT: with raw output, at least two evidence-labelled challenges each classified blocking or non-blocking, the owner's disposition (accept-and-revise / rebut-with-evidence / reject-with-reason), and the supervisor's call with its own reason.` | Recorded in `plan.md` §4 and §7 for DD-1, DD-2, DD-3, DD-4. Implementation honors DD-1 (A8, A11), DD-2 (A12), DD-3 (A4, A5), DD-4 (A1, A6). | `grep -c "^FALSIFIER: " .mypi/spec-c2-gate/run-details/plan.md` | `[citation]` `plan.md` §4:46-60 (D&D queue) and §7:91-201 (Decision log) |
| C6 | `No decision rests on an unbacked claim: every claim carries an evidence class (exec-here / citation / reasoned), the most load-bearing exec-here claim was re-run by the opponent, and any unsupported claim was withdrawn rather than accepted.` | Every claim in this plan is explicitly labeled `[exec-here]`, `[citation]`, or `[reasoned]`. | Audit of `implementation-plan.md` for unlabeled assertions | `[citation]` `plan.md` §3:39-44 (Evidence classes) |
| C7 | `Any regression test added demonstrates its canary with raw output: it FAILS with the fix disabled and PASSES with it restored.` | Enforced on future tests (M1–M4): canary failure demonstration required before green commit. In docs-only run, verified no source/test changes made. | `git diff --name-only main...HEAD -- '*.test.ts' 'test/'` (empty for docs-only; canary logs for code build) | `[citation]` `plan.md` §5:76 (DoD C7 check) and §6:85-89 (Non-added tests) |
| C8 | `plan.md contains a criterion->check table mapping every DoD criterion (quoted verbatim) to the single command or artifact that establishes it.` | Mapped to `plan.md` §5; reflected in Table A of this plan. | Compare `plan.md` §5 text against `session.yaml:144-155` | `[citation]` `plan.md` §5:62-83 (Criterion -> check table) |
| C9 | `An independent consistency verifier confirms the complete set: it ran every check in the table itself with its own pasted raw output, and audited every evidence locator as RESOLVES / DOES NOT RESOLVE, reporting no unresolved cross-document conflict.` | Plan structures modules, interfaces, and file paths to match verified locators with zero discrepancy. | Consistency verifier `FINAL_REPORT` artifact audit | `[citation]` `plan.md` §5:78 (DoD C9 check) |
| C10 | `The reviewer's verdict block begins ATTESTER: reviewer, carries exactly one verdict per DoD criterion in config order with each criterion quoted verbatim, and reports no unresolved blocking issue.` | Plan satisfies all structural and behavioral constraints reviewed by attester. | Reviewer reply payload on A2A bus | `[citation]` `plan.md` §5:79 (DoD C10 check) |

---

## §3 Traceability Table B — Source sections & repo paths to implementation

| Source section / repo path | Subject & normative rule | Implementing module / item | Evidence class |
|---|---|---|---|
| `data-contracts.md` §0 | Freeze header, contract `DC-JEV-C2-GATE` v1.1.0, no local fork/redefinition rule | All modules consume contract types; item A2 | `[citation]` `data-contracts.md:6-24` (§0 Freeze header) |
| `data-contracts.md` §1 | F1–F12 verified source facts (EVENT_TYPES, Envelope schema, payload text/report, etc.) | `src/jev/injection-gate.ts`, `src/contracts/session-schema.ts` | `[citation]` `data-contracts.md:26-39` (§1 Verified source facts) |
| `data-contracts.md` §2 | Config surface: `session.jev.injection_check` (false), `session.jev.injection_threshold` (0.8), `session.jev.injection_timeout_ms` (2000, 0 disables), additive JevSchema delta | `src/contracts/session-schema.ts`; item A1 | `[citation]` `data-contracts.md:41-77` (§2 Config surface) |
| `data-contracts.md` §3 | `InjectionScreenInput` record, `ScreenedEventType`, `ScreenedField`, `InjectionEstimate` call seam, call-site timeout race | `src/jev/injection-gate.ts`; items A2, A3, A5 | `[citation]` `data-contracts.md:79-121` (§3 Classifier input record) |
| `data-contracts.md` §4 | `InjectionScreenResult` record (`score`, `threshold`, `flagged`, `error`) | `src/jev/injection-gate.ts`; items A2, A4, A6 | `[citation]` `data-contracts.md:123-139` (§4 Per-field screen output) |
| `data-contracts.md` §5 | `InjectionGateDecision` record (`gate: "jev-injection-gate"`, `contractVersion: "1.1.0"`, `screens`) | `src/jev/injection-gate.ts`; items A2, A7 | `[citation]` `data-contracts.md:141-161` (§5 Frame decision record) |
| `data-contracts.md` §6 | Classifier-error fallback (`score: null, flagged: true, error: string`), exact error derivation expression, timeout-named message (DD-3) | `src/jev/injection-gate.ts`; items A4, A5 | `[citation]` `data-contracts.md:163-205` (§6 Classifier-error fallback) |
| `data-contracts.md` §7 | Threshold comparator: `flagged = score === null \|\| score >= threshold`; config-driven, audit echo, stub-asserted boundary, check as sole off-switch (DD-4) | `src/jev/injection-gate.ts`; items A1, A6 | `[citation]` `data-contracts.md:207-239` (§7 Threshold and flagged semantics) |
| `data-contracts.md` §8 | Deterministic array ordering: `screens` sorted by `ScreenedField` ordinal ("report" < "text"); flagged wins | `src/jev/injection-gate.ts`; items A6, A7 | `[citation]` `data-contracts.md:241-256` (§8 Ordering rules) |
| `data-contracts.md` §9 | `InjectionGateLogEntry`, `InjectionGateEvent`, `InjectionGateLogLevel` derivation | `src/runtime/runtime.ts` / `src/jev/injection-gate.ts`; item A10 | `[citation]` `data-contracts.md:258-290` (§9 Log/annotation record) |
| `data-contracts.md` §10 | Nullability rules: `correlationId`, `score`, `error` handling | `src/jev/injection-gate.ts`; items A2, A4 | `[citation]` `data-contracts.md:292-308` (§10 Nullability table) |
| `data-contracts.md` §11 | Complete valid JSON instance reference (v1.1.0) | `test/unit/injection-gate.test.ts` fixtures | `[citation]` `data-contracts.md:310-403` (§11 Complete valid instances) |
| `data-contracts.md` §Amendment 2026-10-13 | Amendment v1.0.0 → v1.1.0: timeout key, unsettled-promise clause, error-derivation rule, off-switch & boundary bullets, additive schema delta | `src/contracts/session-schema.ts`, `src/jev/injection-gate.ts`; items A1, A4, A5 | `[citation]` `data-contracts.md:405-475` (§Amendment 2026-10-13) |
| `spec.md` §1 | Actors, insertion point, gate states (`OFF`, `NOT-SCREENED`, `SCREENED-UNFLAGGED`, `SCREENED-FLAGGED`) | `src/runtime/runtime.ts`, `src/jev/injection-gate.ts` | `[citation]` `spec.md` §1:35-75 (Actors, surfaces, gate states) |
| `spec.md` §2 | `SCREENED-FLAGGED`: supervisor observable fields, annotation delivery, log line `warn`, frame not dropped | `src/runtime/runtime.ts`, `src/jev/injection-gate.ts`; items A2, A10, A11 | `[citation]` `spec.md` §2:77-154 (FLAGGED disposition & fields) |
| `spec.md` §3 | `SCREENED-UNFLAGGED`: pass path, `info` log, no-op routing proof | `src/runtime/runtime.ts`, `src/jev/injection-gate.ts`; items A10, A11 | `[citation]` `spec.md` §3:156-187 (UNFLAGGED pass path) |
| `spec.md` §4 | Threshold comparator, config path, bounds `(0,1)`, default `0.8`, equality flags | `src/contracts/session-schema.ts`, `src/jev/injection-gate.ts`; A1, A6 | `[citation]` `spec.md` §4:189-305 (THRESHOLD comparator & bounds) |
| `spec.md` §5 | Log-and-continue policy: annotated & delivered, never dropped, log field derivation (DD-2) | `src/runtime/runtime.ts`, `src/jev/injection-gate.ts`; items A10, A11 | `[citation]` `spec.md` §5:307-374 (LOG-AND-CONTINUE policy) |
| `spec.md` §6 | Classifier-error fallback: seam error & timeout conversion, exact derivation rule, never throw, mirror `verdict-advisory.ts` | `src/jev/injection-gate.ts`; items A4, A5 | `[citation]` `spec.md` §6:376-484 (CLASSIFIER-ERROR FALLBACK) |
| `spec.md` §7 | Scope boundary: `FINAL_REPORT.payload.report` and `RESPONSE.payload.text` screened; other 20 types bypassed | `src/jev/injection-gate.ts`; item A3 | `[citation]` `spec.md` §7:486-528 (Scope boundary) |
| `spec.md` §8 | Supervisor UX reading rules: rendering nulls, correlation linkage | `src/runtime/runtime.ts`; item A10 | `[citation]` `spec.md` §8:530-564 (Supervisor UX) |
| `spec.md` §9 | Non-goals: no veto, no drop, no exit code change, no retry, no local schema extensions | `src/jev/injection-gate.ts`, `src/runtime/runtime.ts`; items A11, A12 | `[citation]` `spec.md` §9:566-585 (Non-goals) |
| `spec.md` §10 | Acceptance checks AC-1 through AC-38 | Test suites in Milestones M1, M2, M3, M4 | `[citation]` `spec.md` §10:587-641 (Acceptance checks table at lines 600-637) |
| `ingestion-spec.md` §1 | Insertion point: `runtime.ts:653-655`, async data callback, serialized per-connection promise chain, try-block containment | `src/runtime/runtime.ts`; items A8, A9 | `[citation]` `ingestion-spec.md` §1:42-114 (Insertion point & serialization) |
| `ingestion-spec.md` §2 | Routing-contract preservation: `routeFrame` valid/undefined unchanged; annotation is additive (DD-1) | `src/bus/router.ts`, `src/runtime/runtime.ts`; item A11 | `[citation]` `ingestion-spec.md` §2:116-182 (Routing-contract preservation) |
| `ingestion-spec.md` §3 | Determinism: §8 array sorting, tie-break disjunction, non-deterministic model caveat | `src/jev/injection-gate.ts`; items A6, A7 | `[citation]` `ingestion-spec.md` §3:184-228 (Determinism & ordering) |
| `ingestion-spec.md` §4 | Failure paths & retry posture: taxonomy, timeout race, DD-3 fallback, never throw, no inline retry | `src/jev/injection-gate.ts`; items A4, A5 | `[citation]` `ingestion-spec.md` §4:230-313 (Failure and fallback paths) |
| `ingestion-spec.md` §5 | Step order: 7-step per-frame pipeline from frame extraction to delivery | `src/runtime/runtime.ts`; items A8, A9, A10 | `[citation]` `ingestion-spec.md` §5:315-336 (Step order) |
| `ingestion-spec.md` §6 | Not-building: no blocking, no routing rewrite, no exit code change, no timeout key | `src/jev/injection-gate.ts`, `src/runtime/runtime.ts` | `[citation]` `ingestion-spec.md` §6:338-348 (Not-building) |
| `plan.md` §2 (`message-validator.ts:17-28`) | `classifyFrame` returns `valid`/`f1`/`f2`; payload content never screened structurally | Upstream untouched; gate executes downstream of `valid` | `[citation]` `plan.md` §2:22 |
| `plan.md` §2 (`router.ts:24-53`) | `routeFrame` F1/F2 drop / ERROR policy; must not be altered | Preserved unchanged; item A11 | `[citation]` `plan.md` §2:23 |
| `plan.md` §2 (`runtime.ts:643`) | Call site of `routeFrame`; `env !== undefined` → `handleEnvelope` (gate insertion point) | `src/runtime/runtime.ts`; item A9 | `[citation]` `plan.md` §2:24 |
| `plan.md` §2 (`runtime.ts:690-700`) | Sender-spoof guard: verifySender plus payload agentId match | Upstream untouched; envelope integrity preserved | `[citation]` `plan.md` §2:25 |
| `plan.md` §2 (`runtime.ts:713-745`) | Per-type dispatch switch; each arm reads own payload shape | Upstream untouched; envelope integrity preserved | `[citation]` `plan.md` §2:26 |
| `plan.md` §2 (`runtime.ts:775-791`) | `handleFinalReport` — peer report text reaches supervisor context | `src/runtime/runtime.ts`; screened by item A3 | `[citation]` `plan.md` §2:27 |
| `plan.md` §2 (`runtime.ts:828-840`) | `handleResponse` — peer response text reaches supervisor context | `src/runtime/runtime.ts`; screened by item A3 | `[citation]` `plan.md` §2:28 |
| `plan.md` §2 (`a2a-schema.ts:9-32`) | `EVENT_TYPES` enum (22 values) | `src/jev/injection-gate.ts`; item A3 | `[citation]` `plan.md` §2:29 |
| `plan.md` §2 (`a2a-schema.ts:119-128`) | `FINAL_REPORT` payload: `report` string screened | `src/jev/injection-gate.ts`; item A3 | `[citation]` `plan.md` §2:30 |
| `plan.md` §2 (`a2a-schema.ts:70-84`) | `RESPONSE` payload: `text` string screened | `src/jev/injection-gate.ts`; item A3 | `[citation]` `plan.md` §2:31 |
| `plan.md` §2 (`a2a-schema.ts:132-147`) | `A2AEnvelopeSchema` — linkage fields `id`, `correlationId`, `sender`, `recipient`, `timestamp` | `src/jev/injection-gate.ts`; item A2 | `[citation]` `plan.md` §2:32 |
| `plan.md` §2 (`docs/jev/integration-map.md:54-62`) | C2 candidate problem statement, log-and-continue requirement | `src/jev/injection-gate.ts`; item A11 | `[citation]` `plan.md` §2:33 |
| `plan.md` §2 (`docs/jev/implementation-plan.md:104-107`) | I4: `src/jev/injection-gate.ts`, opt-in default off, config threshold, log-and-continue | `src/jev/injection-gate.ts`; items A1, A2, A11 | `[citation]` `plan.md` §2:34 |
| `plan.md` §2 (`src/jev/verdict-advisory.ts`) | Precedent: advisory never changes exit code; failed call flagged, never thrown | `src/jev/injection-gate.ts`; item A4 | `[citation]` `plan.md` §2:35 |
| `plan.md` §2 (`src/contracts/session-schema.ts`) | `session.jev` config block mount | `src/contracts/session-schema.ts`; item A1 | `[citation]` `plan.md` §2:36 |
| `plan.md` §2 (`docs/TODO.md:19-20`) | Task origin: C2 peer→supervisor injection gate | Whole feature scope | `[citation]` `plan.md` §2:37 |

---

## §4 Module Layout (Sole-Owner Modules)

### Module 1: `src/contracts/session-schema.ts` (Config Surface Extension)
- **Single responsibility:** Define and validate session configuration schema with Jev injection gate keys (`injection_check`, `injection_threshold`, `injection_timeout_ms`).
- **Exported interface (signature-level):**
  ```ts
  // Extended JevSchema inside session-schema.ts
  export const JevSchema: z.ZodObject<{
    verdict_check: z.ZodDefault<z.ZodBoolean>;
    model: z.ZodDefault<z.ZodString>;
    review_threshold: z.ZodDefault<z.ZodNumber>;
    injection_check: z.ZodDefault<z.ZodBoolean>;
    injection_threshold: z.ZodDefault<z.ZodNumber>;
    injection_timeout_ms: z.ZodDefault<z.ZodNumber>;
  }>;
  export type JevConfig = z.infer<typeof JevSchema>;
  ```
- **Inputs:** Raw `session.yaml` parsed object.
- **Outputs:** Validated `JevConfig` object with `injection_check` defaulting to `false`, `injection_threshold` defaulting to `0.8`, and `injection_timeout_ms` defaulting to `2000` (`0` disables).
- **Consumers:** `src/runtime/runtime.ts`, `src/pi/extension.ts`.
- **Smallest solution:** Add three additive rows inside the existing `z.strictObject` at `src/contracts/session-schema.ts:41-47`.
- **NOT building:** No custom parser, no environment variable overrides, no separate injection config file.

### Module 2: `src/jev/injection-gate.ts` (Injection Screening Engine)
- **Single responsibility:** Screen valid inbound `FINAL_REPORT` and `RESPONSE` payloads for prompt injection, wrapping classifier execution in a timeout race and error boundary, returning an auditable decision record and log entry without throwing or dropping.
- **Exported interface (signature-level, exact contract types):**
  ```ts
  import type { A2AEnvelope } from "../contracts/a2a-schema.js";

  export type ScreenedEventType = "FINAL_REPORT" | "RESPONSE";
  export type ScreenedField = "report" | "text";
  export type InjectionEstimate = (content: string) => Promise<number>;

  export interface InjectionScreenInput {
    frameId: string;
    correlationId: string | null;
    sender: string;
    recipient: string;
    frameTimestamp: number;
    eventType: ScreenedEventType;
    screenedField: ScreenedField;
    content: string;
  }

  export interface InjectionScreenResult {
    frameId: string;
    correlationId: string | null;
    sender: string;
    screenedField: ScreenedField;
    score: number | null;
    threshold: number;
    flagged: boolean;
    error: string | null;
  }

  export interface InjectionGateDecision {
    gate: "jev-injection-gate";
    contractVersion: "1.1.0";
    frameId: string;
    correlationId: string | null;
    sender: string;
    eventType: ScreenedEventType;
    model: string;
    threshold: number;
    flagged: boolean;
    screens: InjectionScreenResult[];
  }

  export type InjectionGateEvent =
    | "injection_screened"
    | "injection_flagged"
    | "injection_classifier_error";

  export type InjectionGateLogLevel = "info" | "warn";

  export interface InjectionGateLogEntry {
    at: number;
    level: InjectionGateLogLevel;
    event: InjectionGateEvent;
    frameId: string;
    correlationId: string | null;
    sender: string;
    screenedField: ScreenedField;
    score: number | null;
    threshold: number;
    flagged: boolean;
    error: string | null;
  }

  export interface InjectionGateDeps {
    estimate: InjectionEstimate;
    now?: () => number;
  }

  export function shouldScreenEnvelope(env: A2AEnvelope): boolean;

  export function createScreenInput(env: A2AEnvelope): InjectionScreenInput | null;

  export function deriveClassifierError(err: unknown): string;

  export function evaluateScreenResult(
    input: InjectionScreenInput,
    score: number | null,
    threshold: number,
    error: string | null
  ): InjectionScreenResult;

  export function screenInboundFrame(
    env: A2AEnvelope,
    config: { model: string; injection_threshold: number; injection_timeout_ms: number },
    deps: InjectionGateDeps
  ): Promise<{ decision: InjectionGateDecision; logEntry: InjectionGateLogEntry } | null>;
  ```
- **Inputs:** Valid `A2AEnvelope`, gate config (`model`, `injection_threshold`, `injection_timeout_ms`), and `InjectionGateDeps` (`estimate` function).
- **Outputs:** `{ decision: InjectionGateDecision, logEntry: InjectionGateLogEntry }` or `null` if event is not in `ScreenedEventType`.
- **Consumers:** `src/runtime/runtime.ts`.
- **Smallest solution:** Pure functional transformer wrapping the async `estimate` call in `Promise.race` against `injection_timeout_ms` inside `try/catch`, converting failure via `err instanceof Error && err.message !== "" ? err.message : String(err) !== "" ? String(err) : "classifier error"` to §6 fallback record, applying `>=` threshold comparison, and returning frozen decision records.
- **NOT building:** No HTTP client, no model registry lookup, no retry loops, no tokenizers, no multi-field heuristics.

### Module 3: `src/runtime/runtime.ts` (Runtime Inbound Integration & Serialization)
- **Single responsibility:** Inbound frame dispatch loop: serialize frame dispatch per connection via async promise chaining, invoke `screenInboundFrame` inside try-containment for valid envelopes when gate is enabled, append log entry, and pass unchanged envelope to `handleEnvelope`.
- **Exported interface (signature-level changes only):**
  - Internal dispatch site at lines ~638-655 in `src/runtime/runtime.ts`:
  ```ts
  // Private connection dispatch chain tracking inside Runtime class
  private connectionChains: Map<string, Promise<void>>;

  private handleInboundData(
    chunk: Buffer,
    connId: string,
    socket: Socket
  ): Promise<void>;
  ```
- **Inputs:** Inbound TCP chunk, `ConversationLog` handle, session config `session.jev`.
- **Outputs:** Frame dispatch serialized per connection, log appended to `conversation.jsonl`, envelope routed to `handleEnvelope(env, connId, socket)`.
- **Consumers:** `src/pi/launch.ts`, supervisor session runner.
- **Smallest solution:** Make socket data handler async with a per-connection promise chain (`this.connectionChains.get(connId)`), check `session.jev?.injection_check`, await `screenInboundFrame` inside the existing try block, write log via `this.conversationLog.append`, and call `this.handleEnvelope`.
- **NOT building:** No frame routing alteration, no socket destruction on flag, no quarantine buffer, no exit code mutation, and no modification of `A2AEnvelopeSchema` (`src/contracts/a2a-schema.ts:147`).

---

## §5 Milestones (Test-First: Red → Minimal Green → Refactor)

### Milestone M1: Config Schema Extension (Additive Delta)
- **Red test:** `test/unit/session-schema.test.ts`
  - Test name: `"session.jev config accepts injection_check, injection_threshold, and injection_timeout_ms with defaults"`
  - Asserts parsing empty `jev: {}` yields `{ verdict_check: false, model: "openrouter/typesafe/jev-1.13", review_threshold: 0.5, injection_check: false, injection_threshold: 0.8, injection_timeout_ms: 2000 }`.
  - Asserts `injection_timeout_ms: 0` is valid (disables bound), while negative numbers reject with Zod error.
  - Asserts invalid `injection_threshold: 0` or `1.5` rejects with Zod validation error.
- **Minimal Green:**
  - Edit `src/contracts/session-schema.ts:41-47` to add `injection_check`, `injection_threshold`, and `injection_timeout_ms` fields to `JevSchema`.
- **Refactor:**
  - Verify strictObject guarantees hold and that existing session configs parse without regression.

### Milestone M2: Injection Gate Core Module & Error Derivation
- **Red test:** `test/unit/injection-gate.test.ts`
  - Tests covering AC-1..AC-38:
    1. `"shouldScreenEnvelope returns true only for FINAL_REPORT and RESPONSE"`
    2. `"createScreenInput correctly maps FINAL_REPORT -> report and RESPONSE -> text"`
    3. `"screenInboundFrame returns null for non-screened event types"`
    4. `"screenInboundFrame marks flagged=true when score >= threshold (equality flags, stub-asserted)"`
    5. `"screenInboundFrame marks flagged=false when score < threshold"`
    6. `"screenInboundFrame catches seam rejection and derives error message without throwing"`
    7. `"screenInboundFrame converts Error('') and empty String(err) to floor 'classifier error'"`
    8. `"screenInboundFrame catches NaN/Infinity/out-of-range and returns fallback record with score=null, flagged=true"`
    9. `"screenInboundFrame times out when estimate takes longer than injection_timeout_ms and returns timeout error"`
    10. `"screenInboundFrame does not timeout when injection_timeout_ms is 0"`
    11. `"decision screens array is sorted by ScreenedField ordinal"`
    12. `"log entry level is warn iff flagged=true, else info"`
    13. `"log entry event is injection_classifier_error on error, injection_flagged on flag, injection_screened otherwise"`
- **Minimal Green:**
  - Implement `src/jev/injection-gate.ts` satisfying all interfaces, `Promise.race` timeout race, and error derivation rule.
- **Refactor:**
  - Ensure zero `any` casts, complete TypeScript compliance, and exact key insertion order per contract §8.

### Milestone M3: Async Per-Connection Dispatch Serialization
- **Red test:** `test/unit/runtime-dispatch-serialization.test.ts`
  - Test name: `"Runtime serializes inbound frames per connection preserving arrival order across async gate calls"`
  - Asserts that when frame 1 has an artificial 100ms classifier delay and frame 2 has a 10ms delay on the same socket, frame 1 completes `handleEnvelope` strictly before frame 2 begins `handleEnvelope`.
- **Minimal Green:**
  - Update `src/runtime/runtime.ts:638-639` to maintain a per-connection promise chain (`Map<string, Promise<void>>`) chaining each frame's execution.
- **Refactor:**
  - Ensure connection cleanup cleans up promise map entries on socket close/destroy.

### Milestone M4: Runtime Inbound Integration & Log-and-Continue
- **Red test:** `test/integration/injection-gate.test.ts`
  - Tests:
    1. `"inbound valid frame is screened, logged to conversation.jsonl, and delivered to handleEnvelope when injection_check is true"`
    2. `"flagged inbound frame is annotated with warn log and still delivered without dropping or throwing"`
    3. `"classifier error and timeout inbound frames produce warn log and still deliver envelope"`
    4. `"inbound frame bypasses screening completely when injection_check is false or absent"`
- **Minimal Green:**
  - Wire `src/runtime/runtime.ts` at line ~653 inside `if (env !== undefined)` and inside the existing `try` block (`runtime.ts:654-663`).
- **Refactor:**
  - Verify error handling in runtime preserves socket lifecycle and that contract-violating throws trigger existing `envelope-handler-threw` logging without leaking unhandled rejections.

### D3 (M4) Production Estimate Item — Added After Freeze
- **Supplier:** `buildInjectionEstimate` in `src/pi/extension.ts:509-543` supplies the production estimate. When `session.jev.injection_check` is true the supplier always exists: `buildInjectionEstimate` returns `undefined` only when the gate is off (`src/pi/extension.ts:516`). An unresolved slug yields an estimate that rejects when called (`src/pi/extension.ts:526-532`), and the gate's `try/catch` converts that rejection to the §6 fallback `score: null, flagged: true` (`src/jev/injection-gate.ts:189-196`).
- **Why A8-A12 alone left the gate unable to screen anything:** Without `buildInjectionEstimate` supplying the RuntimeOptions seam (`src/pi/extension.ts:232`), `injectionEstimate` is undefined. At `src/runtime/runtime.ts:731`, the gate condition (`injection_check === true && this.injectionEstimate !== undefined`) fails, so the runtime skips the screen and frames pass UNSCREENED. The production estimate supplier provides the classifier call that A8–A12 needed to actually screen content.
- **Evidence class:** `[citation]` `src/pi/extension.ts:232` (injectionEstimate seam) · `[citation]` `src/pi/extension.ts:509-543` (buildInjectionEstimate, with B2 fail-closed branch at line ~531) · `[citation]` `src/pi/extension.ts:528` (B2 comment: "fail closed — an unresolved slug must not become an implicit pass (§2: injection_check is the only total off-switch; §6: unknown is not a pass).")



---

## §6 Future Commands (Real, Runnable from package.json/justfile)

Every command below is runnable in this repository as declared in `package.json` and `justfile`.

| Target | Command | Purpose |
|---|---|---|
| Unit & Integration Tests | `bun run test` (or `vitest run`) | Run complete Vitest suite across unit and integration tests |
| Single Gate Test | `vitest run test/unit/injection-gate.test.ts` | Run injection gate unit tests |
| Single Serialization Test | `vitest run test/unit/runtime-dispatch-serialization.test.ts` | Run per-connection async serialization tests |
| Typecheck | `bun run typecheck` (or `tsc --noEmit`) | Validate TypeScript types with no emit errors |
| Live Jev Integration Test | `bun run test:jev` (or `JEV_LIVE=1 vitest run test/integration/jev-live.test.ts`) | Run live classifier tests against external Jev endpoint |
| Supervisor Launch | `bun src/pi/launch.ts` | Start supervisor runtime |
| Repo Clean | `git clean -fdX -- .mypi/` | Remove untracked and gitignored run artifacts |

[exec-here] `cat package.json` scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, `"test:jev": "JEV_LIVE=1 vitest run test/integration/jev-live.test.ts"`.

---

## §7 Per-Module YAGNI & Smallest-Solution Notes

### 1. `src/contracts/session-schema.ts`
- **Smallest solution:** Add three additive rows inside `JevSchema` (`injection_check`, `injection_threshold`, `injection_timeout_ms`) using standard Zod primitives at lines 41–47.
- **NOT building:** No custom parser, no nested sub-objects, and no runtime schema mutation.

### 2. `src/jev/injection-gate.ts`
- **Smallest solution:** Pure function taking `A2AEnvelope` and `InjectionEstimate`, executing one `Promise.race` timeout wrapped in `try/catch`, deriving errors per contract §6, and returning frozen `InjectionGateDecision` (v1.1.0) and `InjectionGateLogEntry` records.
- **NOT building:** No inline network retries, no token counting, no payload mutation, no heuristic pre-scanners, and no secondary voting logic.

### 3. `src/runtime/runtime.ts`
- **Smallest solution:** Maintain per-connection dispatch promise chain, check opt-in boolean; if true, await `screenInboundFrame` inside existing try block, append log entry to `conversation.jsonl`, and proceed to existing `this.handleEnvelope`.
- **NOT building:** No quarantine message queue, no custom socket protocol, no frame drop mechanism, no exit code override, and no modification of `A2AEnvelopeSchema` (`src/contracts/a2a-schema.ts:147`).

---

## §8 Risks, Mitigations & Detection Commands

| Risk Code | Risk Description | Mitigation | Detection Command |
|---|---|---|---|
| R1 | Classifier latency blocks inbound event loop indefinitely | `session.jev.injection_timeout_ms` (default 2000ms) bounds seam execution at call site; `0` disables | `vitest run test/unit/injection-gate.test.ts` |
| R2 | Model non-determinism (~0.03 spread per E2) causes flakiness | Default threshold set to `0.8`, sitting well clear of the baseline spread; fail-closed fallback | `grep -n "default(0.8)" src/contracts/session-schema.ts` |
| R3 | Seam throw or timeout leaks to runtime loop and destroys socket | Local `try/catch` in `injection-gate.ts` catches all rejections/timeouts and returns §6 fallback record | `grep -n "throw" src/jev/injection-gate.ts` (must return empty) |
| R4 | Accidental drop of flagged frame breaks valid workflow | DD-2 log-and-continue policy: `handleEnvelope` is called unconditionally on all `valid` frames | `grep -n "return undefined" src/jev/injection-gate.ts` (must return empty) |
| R5 | Out-of-order frame dispatch caused by async gate calls | Ingestion serialized mechanism: per-connection promise chain in `runtime.ts` preserves intra-connection arrival order | `vitest run test/unit/runtime-dispatch-serialization.test.ts` |
| R6 | Annotation sink gap: decision record not visible in supervisor LLM context | Explicitly document that delivery is via `InjectionGateLogEntry` in `conversation.jsonl`; `A2AEnvelopeSchema` must not be modified | `grep -n "strictObject" src/contracts/a2a-schema.ts` |

---

## §9 Opt-In / Default-Off and Config-Threshold Implementation Facts

- **Opt-In & Default-Off Fact:** `session.jev.injection_check` is strictly `false` by default. When `session.jev` is omitted or `injection_check` is `false`, `screenInboundFrame` is never executed and zero log entries are emitted. This is the sole total off-switch because the open interval `(0,1)` for `injection_threshold` cannot express never-flag or always-flag.
  [citation] `.mypi/spec-c2-gate/data-contracts.md:48`, `:226-231` (§7 off-switch bullet)
- **Threshold as Config Fact:** `session.jev.injection_threshold` is read dynamically from session configuration at execution time (defaulting to `0.8` on the open interval `(0,1)`). The comparator is strictly `score >= threshold` asserted against exact doubles with no epsilon. No hardcoded constant is embedded in `src/jev/injection-gate.ts`.
  [citation] `.mypi/spec-c2-gate/data-contracts.md:49`, `:207-239` (§7 Threshold and flagged semantics)
- **Timeout as Config Fact:** `session.jev.injection_timeout_ms` is read dynamically (defaulting to `2000`, integer `gte(0)`). A value of `0` disables the timeout race.
  [citation] `.mypi/spec-c2-gate/data-contracts.md:50`, `:112-118` (§3 call seam / timeout resolution)

---

## §10 Canary Requirement (DoD C7)

Per DoD Criterion C7 (`plan.md` §5):
Any regression or integration test introduced for the C2 injection gate must explicitly demonstrate its canary validity:
1. The test must be run and shown **FAILING** when the gate logic is disabled or inverted (e.g., when fallback error handling is commented out or when threshold comparator is changed from `>=` to `<`).
2. The test must be run and shown **PASSING** when the fix/logic is restored.
3. Raw command output for both states must be captured and recorded in the implementation verification log.

---

## §11 Supervisor-Relayed Oppositions and Calls

The load-bearing decisions recorded in `plan.md` §4 and §7 are incorporated into this plan with complete fidelity:
- **DD-1 (Routing contract preservation & async serialization):** Owner `pipeline_spec_author`, Opponent `data_contract_author`. Resolved: `routeFrame` returns `valid`/`undefined` as before; gate annotates and never turns a valid frame into `undefined`. Inbound socket callback becomes async and serializes per-connection frame dispatch to preserve intra-connection arrival order.
- **DD-2 (Log-and-continue disposition & annotation sink):** Owner `spec_author`, Opponent `implementation_planner`. Resolved: A flagged frame is annotated and still delivered; gate never drops or suppresses frames. Delivery to supervisor context is accomplished via `conversation.jsonl` log entries; `A2AEnvelopeSchema` is strictly preserved.
- **DD-3 (Classifier-error fallback & timeout non-resolution):** Owner `data_contract_author`, Opponent `pipeline_spec_author`. Resolved: Rejection, malformed score, or unsettled promise past `injection_timeout_ms` maps to `score: null, flagged: true, error: <derived string>` and never throws. Error derived via contract §6 exact expression.
- **DD-4 (Configurable threshold & additive schema delta):** Owner `data_contract_author`, Opponent `spec_author`. Resolved: Threshold is `session.jev.injection_threshold` compared as `score >= threshold` (stub-asserted). Schema delta is additive inside `src/contracts/session-schema.ts:41-47`.

---

## §12 Critical Implementation Warning

**CRITICAL WARNING:** The injection gate must NEVER throw an exception or return `undefined` under any circumstances. In `src/runtime/runtime.ts`, any unhandled error inside the inbound dispatch loop causes `envelope-handler-threw` and destroys the peer socket. The injection gate must guarantee 100% exception containment via local fallback wrapping (`src/jev/injection-gate.ts`), with secondary containment inside the existing try block at `src/runtime/runtime.ts:654-663`.
