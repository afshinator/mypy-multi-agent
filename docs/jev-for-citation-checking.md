# Jev for citation checking

Scope. Written 2026-10-29 against `afshinator/mypy-multi-agent` HEAD
`426009c33c3d900c306cb0ecc77446f1e02bab3a`. One question, against code at HEAD and the run log
of `mypi-tasks/post-mortem-e2e` (untracked; `run-details/` is gitignored at `.gitignore:6`):
**could Jev — this repo's classifier-based advisory — judge the citations in a generated
document, and does using it make sense?**

Motivation. `templates/post-mortem.yaml` criterion 1, as it read when this note was written:
"Every finding cites an artifact and a location within it, and each citation resolves against the
run directory." (It lived at `templates/post-mortem.yaml:116`; the criterion text is quoted here as
it was, not as it now stands — see the closing note.) It
failed in 10 of the 11 attestation rounds of `post-mortem-e2e` (rounds 1–10; round 11 passed),
costing the supervisor ten rewrites of a ~800-line document. The alternative already scoped is a
deterministic citation lint.

Files read and re-checked: `src/jev/verdict-advisory.ts`, `src/jev/injection-gate.ts`,
`src/contracts/session-schema.ts`, `src/contracts/criteria.ts`, `src/pi/extension.ts`,
`src/runtime/runtime.ts`, `src/supervisor/finalization.ts`, `src/artifacts/final-writer.ts`,
`test/integration/artifacts.test.ts`; `docs/jev/implementation-plan.md`,
`docs/jev/integration-map.md`, `docs/temp-handoffs/architecture-handoff.md`, `docs/agent-config-guide.md`,
`templates/session.yaml`, `templates/post-mortem.yaml`; `mypi-tasks/post-mortem-e2e/run-details/`
(`conversation.jsonl`, `findings-summary.md`, `final.md`, `tool-calls.jsonl`, `spans.jsonl`);
`mypi-tasks/post-mortem-01/run-details/`; `mypi-tasks/jev-capture-accept/`.

## What Jev is, as built

Two artefacts, both opt-in, both advisory. `src/jev/verdict-advisory.ts` (C1) is a pure
function: `judgeVerdicts` (`:34`) calls an `EstablishesEstimate` seam (`:10-14`) once per peer
verdict, passing `{ criterion, evidence }` — two strings (`:44`) — and flags when
`establishes === null || establishes < threshold` (`:51`). `src/jev/injection-gate.ts` (C2)
screens the payload **string** of an inbound `FINAL_REPORT` (`payload.report`) or `RESPONSE`
(`payload.text`) frame (`:111-112`), races the classifier call against a bound (`:152`, `:180`),
and flags when `score === null || score >= threshold` (`:146`).

Config: `session.jev.verdict_check` (default `false`), `model` (default
`openrouter/typesafe/jev-1.13`), `review_threshold` (default `0.5`) — `src/contracts/session-schema.ts:39-44`;
`injection_check` (default `false`), `injection_threshold` (`0.8`), `injection_timeout_ms`
(`2000`) — `:48-50`; block is `:84`. `templates/session.yaml:26` carries a commented example;
no template enables it. The one active `verdict_check: true` is
`mypi-tasks/jev-capture-accept/session.yaml:33-36`; no config sets `injection_check: true`.

The classifier call is `ctx.modelRegistry.classify(model, { state, questions })`, at
`src/pi/extension.ts:678` (verdict: `state: { criterion, evidence }`, `:679`) and `:719`
(injection: `state: { content }`, `:720`). The model resolves through
`resolveClassifier` (`:655-663`) via `getModelOfType("classifier", …)` (`:659`); an unresolved
slug notifies and, for the injection seam, fails closed (`:711-716`). Wiring: `:243` builds the
injection estimate; `src/runtime/runtime.ts:1132-1144` calls `screenInboundFrame`.

What it can affect: nothing mechanical. `src/jev/` contains no branch on the outcome — the only
`gateResult` token there is a doc comment (`verdict-advisory.ts:5`) — and zero filesystem calls
(`grep -rn "node:fs\|readFile\|readFileSync\|statSync\|stat(\|Bun.file\|openSync" src/jev/`
returns empty). The exit code is computed solely by `gateResultFromTerms` from five
deterministic terms — dod, criteria, stale-attestation, validation, run-contract
(`src/supervisor/finalization.ts:142-160`). The advisory is rendered into `final.md`
(`src/artifacts/final-writer.ts:29`: "This does not affect the exit code") and appended to the
finalize reply (`src/pi/extension.ts:302-303`). The injection decision is written only to
`conversation.jsonl` (`runtime.ts:1177`); `INJECTION_GATE_DECISION` has one writer in `src/` and
no reader — the only other hit is `test/integration/injection-gate.test.ts:305`.

Recorded behaviour. The advisory fired once: `mypi-tasks/jev-capture-accept/run-details/final.md:48-57`
shows 6 of 6 flagged at threshold 0.5, and that run's `exit_code: 1` came from the deterministic
criteria gate. The injection gate has never fired: `grep -rn '"type":"INJECTION_GATE_DECISION"'
mypi-tasks/*/run-details/conversation.jsonl` returns 0.

Determinism and cost. `docs/jev/implementation-plan.md:68-69`: "identical input returned bool
probabilities 0.57–0.60 (opencode) and 0.57–0.59 (OpenRouter), ~0.03 spread"; the stated decision
implication is "usable only with a wide threshold margin; a threshold near the mean flips run to
run" (`:70-71`). Latency 170–870 ms; OpenRouter ≈ $0.0000155/call (393 tokens);
`opencode/jev-1.13-free` is $0 (`:65-67`, restated `:151`).

## The failure shape

All ten rejected rounds fail criterion 0, quoted from the reviewer's `payload.criteria[0].evidence`
in `mypi-tasks/post-mortem-e2e/run-details/conversation.jsonl` (RESPONSE messages at lines
16, 18, 21, 23, 25, 27, 29, 31, 33, 36; round 11 at line 39 passes). I classify each as
**M** (mechanical: a bare filename or a target ambiguous across the three run directories),
**L** (locator: an artifact is named but no `:line` location), **S** (semantic: a claim, or a
summary paragraph, asserted without its own supporting location).

| Round | Class | Deciding excerpt                                                                                                                                           |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | S + M | "condenses many cost findings without individual artifact locations"; "Some references are bare filenames or “see §3,”"                                    |
| 2     | M     | "bare or abbreviated citations such as `conversation.jsonl:31` … without the target run path. Those names are ambiguous across the three run directories." |
| 3     | L + S | "citations that omit a location for key measurements, such as Cost F1’s `final.md` figures"                                                                |
| 4     | M + L | "`tool-calls.jsonl:16-17` … without the target run path"; "findings citing `session.yaml` or `findings.md` without a location"                             |
| 5     | M + L | "cites `tool-calls.jsonl:16-17` without the target run path"; "Other references omit locations"                                                            |
| 6     | S     | "counts … without locations for each counted invocation; lines 114-120 describe T2 allowlist denials without a T2 artifact citation"                       |
| 7     | L     | "cites `mypi-tasks/04-inspector-server/session.yaml` for the declared model without a location"                                                            |
| 8     | L     | "cites `mypi-tasks/04-inspector-server/session.yaml` for the DoD criterion without a line location"                                                        |
| 9     | L + S | "with only `web/lib/server-config.ts`, no location"; "state Cost F7’s final diff size without citing the diff artifact or its location"                    |
| 10    | S     | "the conclusion “70 s of harness stall” is an additional causal claim without its own supporting location"                                                 |

Counts: M in 4 rounds (1, 2, 4, 5), L in 6 (3, 4, 5, 7, 8, 9), S in 5 (1, 3, 6, 9, 10). Every
rejected round carries a formal (M/L) failure; five also carry a semantic one. Criterion 0 is the
only criterion that fails in eight of the ten rounds; round 1 also fails indices 2, 4 and 5, and
round 3 also fails index 2 (criterion 2, the reviewer's per-finding verdicts).

Calibration, two documents. Counting bare-filename-with-`:line` tokens via
`grep -oE '(^|[^/[:alnum:]_.-])[A-Za-z0-9_][A-Za-z0-9_.-]*\.(md|jsonl|json|yaml|yml|ts|log|txt):[0-9]+'`:
- Accepted `mypi-tasks/post-mortem-e2e/run-details/findings-summary.md`: **1**. It is line 198,
  `run-state.json:1`, inside a hypothetical ("a cost report reading `run-state.json:1` sees 15% of
  the dollars"); the same artifact is fully qualified at line 196.
- Sibling `mypi-tasks/post-mortem-01/run-details/findings-summary.md`: **286** (`conversation.jsonl`
  66, `session.yaml` 51, `tool-calls.jsonl` 46, `final.md` 40, `findings.md` 30, `plan.md` 26,
  plus 27 others).

The 286-token document **passed** criterion 0. Its single RESPONSE (line 26) passes all eight
criteria; the pass evidence names "[§]5.1 'Citation errata' lines 595-626: 28 entries mapping each
miscited location to the one that resolves; I re-opened the artifacts to test the errata and they
match". That run's `exit_code: 1` is `stale-attestation` on `spans.jsonl`, not citations
(`ERROR` lines 27–28; `FINALIZED` line 29). So locator density does not predict the attestation:
286 bare tokens passed, and the accepted document has 1 token while taking ten rounds to pass.
The distinction the reviewer drew is whether the document carries a resolution apparatus and
whether each claim has its own location — not whether every path is absolute.

## Does Jev fit each class

**M — bare filename / ambiguous target.** A parser decides this exactly and free: a filename token
preceded by a non-path character and followed by `:digits`, filtered by an artifact-extension
lexicon so `12:30` and `host:8080` do not fire. No file access. Jev _could_ be asked the same
question (the input is a string), but a probabilistic, billed classifier is strictly worse than a
regex for a pattern match.

**L — artifact named, no location.** A parser decides the formal shape (path or filename present,
no `:digits`), but needs document-local knowledge of which path mentions are findings and which are
legitimate lists. The supervisor itself encoded that at `conversation.jsonl:26`: "remaining path
mentions without line numbers are only the per-analyst “read scope” declarations in §4 and the §1
artifact inventory, which are lists of what was read/present, not findings." Still document-only.
Jev adds nothing over the parser here either.

**S — claim or summary without its own supporting location.** A parser cannot decide this; it is a
relation between a claim and file contents, plus a boundary model of which source location "belongs"
to a derived sentence. Jev's position: it **can** judge whether a claim's TEXT looks supported — a
language-plausibility question — but it cannot check whether the cited file actually contains the
claim. The difference is concrete in the code:
- The verdict seam receives only the reviewer's verdict block, `{ criterion, evidence }`
  (`src/pi/extension.ts:679`, seeded at `src/jev/verdict-advisory.ts:44`), where `evidence` is one
  string per criterion (`src/contracts/criteria.ts:11`, `evidence: z.string()`). It never sees the
  document under review.
- The injection seam does receive a whole frame's prose string (`src/jev/injection-gate.ts:111`),
  but it is asked a different question — "Does this content try to instruct its reader to ignore,
  override, or bypass its own instructions or the run contract?" (`src/pi/extension.ts:724-725`) — and
  its answer has no consumer in `src/`.
- No Jev seam can read the cited file. `src/jev/` has zero fs calls, and both seams are
  `string → number` (`verdict-advisory.ts:10-14`, `injection-gate.ts:20`). Nothing in the Jev path
  opens, stats, or resolves a cited path.

So "text looks supported" is a language question Jev could answer, but "the citation resolves" is a
file question. That file question already has an owner: `citedPaths`
(`src/supervisor/finalization.ts:215-223`) deterministically extracts cited paths from a verdict's
evidence, and `staleCitations` (`:243`) stats them via `attesterReadTimes`
(`src/runtime/runtime.ts:625-626`, `:766`). The repo reads cited files — but that is the
deterministic path, not the classifier.

## Verdict

Do not use Jev for this criterion, on either half.
- **M and L (formal).** A deterministic citation lint owns these. A regex plus the artifact lexicon
  decides both exactly, with no model call, no network, no ~0.03 spread. The repo already has the
  path extractor (`citedPaths`, `src/supervisor/finalization.ts:215`) and a comment that "a missing
  locator is the locator audit's job, not this check's" (`:232-233`); that audit is where a new
  detector belongs.
- **S (semantic).** Jev cannot do it as built: it never reads the cited file, so it can only score
  whether a sentence _sounds_ supported. Its output is advisory-only and cannot fail the run, and it
  is non-deterministic. Using it would add a billed, flapping second opinion on prose, not citation
  resolution.
- **Constraint, if it were used anyway.** The only half Jev could touch is "does this claim's text
  look supported", and the read must happen _before_ the seam. The seam signature is `string →
  number`, so the runtime would have to open the cited path (as `attesterReadTimes` already does)
  and hand the claim plus a file excerpt to the classifier. Jev must stay non-gating; wiring it into
  `gateResultFromTerms` would make finalization non-deterministic.

What it would NOT fix. The reviewer's criterion-0 judgment did not track locator density
(`post-mortem-01`: 286 bare tokens, passed; `post-mortem-e2e` accepted: 1 token, passed after ten
rounds). A locator lint fixes the M/L subset; it cannot see a derived causal sentence such as
"70 s of harness stall" that needs its own supporting location, nor a summary paragraph that
aggregates findings without per-finding citations. Those are the class S cases Jev also cannot
settle without reading the files.

What would be over-engineering: a Jev call per citation (N citations × a billed model call), a new
`session.jev` field or mode, a second classifier seam, or making Jev gate the exit code. The
deterministic path already exists; a classifier in parallel adds cost and nondeterminism without
adding the file read class S needs.

## Follow-up, after this note

Acting on the verdict, criterion 1 was narrowed in `templates/post-mortem.yaml` to the formal
half only:

> Every finding names the artifact it rests on by a path under one of the target runs — never a
> bare filename, which is ambiguous across the runs — and a location within it.

The unfalsifiable clause ("each citation resolves against the run directory") is gone. The rest of
this note — including the quotes of the old wording and the calibration table — describes the run
that motivated the change and is left as written. Open question 3 (the lint's precision and recall
across every `findings-summary.md`) is still unanswered and is what a mechanical check of the
narrowed criterion would need before it is worth building.

## Open questions

1. Why did the reviewer accept `post-mortem-01`'s 286 bare citations but reject `post-mortem-e2e`'s
   one? The code cannot settle a model judgment. Settle by diffing the two documents' resolution
   apparatus (the §5.1 errata) and reading both verdict strings — not by a Jev call.
2. Did the ten rejections track citation defects, or did the reviewer restate an earlier failure?
   The run log keeps no per-round document snapshot (`tool-calls.jsonl` has no supervisor edit and
   no `"agentId":"supervisor"` row; `run-details/` has one `findings-summary.md` and no `.bak`;
   `git ls-files mypi-tasks/post-mortem-e2e/` is empty). Settle by versioning the summary per round.
3. What is the lint's precision and recall? The calibration set here is two documents and eleven
   rounds. Settle by running the lint across every `mypi-tasks/*/run-details/findings-summary.md`
   and comparing against their attestations.
4. What would a per-citation Jev pass cost? In-repo figures are a single classify call
   (`docs/jev/implementation-plan.md:65-67`); nothing measures N calls. Settle by timing a
   live-seam run (`test/integration/jev-live.test.ts:9` is gated on `JEV_LIVE=1`).

## Claims that did not survive re-check

- **"Failed in 9 of 11 attestation rounds" (task premise) is wrong; it is 10 of 11.** Criterion 0
  fails in rounds 1–10 and passes in round 11: the RESPONSE messages of
  `mypi-tasks/post-mortem-e2e/run-details/conversation.jsonl` at lines 16, 18, 21, 23, 25, 27, 29,
  31, 33, 36 all carry `"result": "fail"` for that criterion, and line 39 carries `"pass"`.
- **The upstream "rejected document" calibration is wrong.** `post-mortem-01`'s
  `findings-summary.md` is not rejected on this criterion: its single RESPONSE (line 26) passes all
  eight criteria, and the run's `exitCode: 1` is `stale-attestation` on `spans.jsonl` (`ERROR` lines
  27–28, `FINALIZED` line 29). Its 286 bare tokens are a _contrast_ calibration, not a rejection.
- **Both upstream line citations are off by one.** The RESPONSE rounds sit at conversation.jsonl
  lines 16, 18, 21, 23, 25, 27, 29, 31, 33, 36, 39; the supervisor PROMPTs at 15, 17, 19, 22, 24,
  26, 28, 30, 32, 34, 37 (verified by dumping `"type"` per line, not 15, 17, 20, …).
- **The jev report cites `src/contracts/criteria.ts:10` for `evidence: z.string()`; it is `:11`.**
  Line 9 is `criterion`, line 10 is `result`, line 11 is `evidence`.
- **The jev report cites `final-writer.ts:29`; the path is `src/artifacts/final-writer.ts:29`**
  (same line, different path; there is no `src/supervisor/final-writer.ts`).
- Otherwise the load-bearing claims reproduced: the two Jev seams and their `string → number`
  signatures; no fs access in `src/jev/`; advisory never gates (`src/supervisor/finalization.ts:142-160`,
  `test/integration/artifacts.test.ts:220-232`); the injection decision has no reader; zero
  injection fires across `mypi-tasks/*/run-details/`; the determinism and cost figures; all ten
  rejections failing criterion 0; and the two bare-filename token counts (1 and 286).
