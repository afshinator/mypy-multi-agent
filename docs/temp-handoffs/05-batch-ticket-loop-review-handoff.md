# Handoff — does the triage exploration support a batch ticket loop?

Repo: `afshinator/mypy-multi-agent`, HEAD `80604e1`, 2026-10-31, tree clean.
This is a review, not a change: nothing was edited, launched or labelled. Its job was to test one
proposal against the artifacts that exist.

**The proposal under review.** Use the multi-agent system to iterate a batch of tickets: for each,
verify its assertions and the problem it claims, extract a workable Definition of Done (DoD) or
decide the ticket is not automatable (a human decision is needed), persist that DoD in the ticket,
then execute the tickets respecting their DoDs — with one chosen configuration of agents and models
deemed adequate for every ticket in the batch.

Read `docs/explorations/triage-automation/triage-loop-brief.md` first; it is the decision record. This document adds only what the
review found that the brief does not already say.

## Verdict

Reconciles on one leg, and that leg is measured: **issue → verified DoD, with a refusal branch**
exists as text and has evidence. **Batch iteration**, **DoD persistence** and **one config adequate
for all tickets** exist nowhere — not in code, not in docs as a decision. Batch-vs-single is an
explicitly open question in the source documents, so the proposal is the first answer to it rather
than a reconciliation with one.

The enforcement gap in the brief is unchanged and confirmed: nothing runs either prompt.

## Findings (F)

**F1 — The exploration is text plus evidence, and nothing executes it.**
`docs/explorations/triage-automation/triage-prompt.md` (issue → DoD, conditional), `docs/explorations/triage-automation/triage-verifier.md` (claim-table re-check
by a fresh agent on another model family), `docs/explorations/triage-automation/triage-loop-brief.md` (D1–D9, R1–R6, 8 open
questions), `docs/temp-handoffs/04-triage-run-type-handoff.md` (three candidate homes).
Evidence: `docs/explorations/triage-automation/evidence/triage-prompt-2026-10-29.md` (two blind tests),
`docs/explorations/triage-automation/evidence/triage-verifier-calibration-2026-10-30.md` (two planted-defect tables).
Confirmed unenforced: `rg -n triage justfile package.json scripts/ src/ test/` exits 1; `rg -n -i
triage test/` exits 1. No triage report artifacts exist on disk (`find mypi-tasks -iname '*triag*'
-o -iname '*claim*'` → empty).

**F2 — Measured performance.** Prompt: nine runs, one DoD produced, 60–95k tokens per issue.
Verifier: 6 turns / ~20k tokens across two tables, zero false matches, and two rows the author
believed sound were correctly refused. Eight open tickets ≈ 0.5–0.9M tokens of triage before any
implementation, at the brief's rates (which the prior handoff already calls stale).

**F3 — The runtime has no concept of an issue.** `rg -n "gh issue|issue_number|ticket" src/` exits 1.
The ask is static: `src/contracts/session-schema.ts:112-119` holds `title`, `description`,
`definition_of_done: string[]`. One run = one ask = one DoD list. The supervisor's registered tools
are the ten orchestration tools (`src/pi/extension.ts:416-623`), and `src/pi/supervisor-prompt.md`
never mentions the tracker — a run cannot fetch its own ticket.

**F4 — The gate already enforces "respect the DoD".** `src/supervisor/finalization.ts:96-122`
requires one attester verdict per criterion, in order, `result: pass`, text equal after
`normalizeCriterion` (`:78-85`: strips backticks, quote styles, dashes, collapses whitespace). A
count or text mismatch fails the `criteria` term. This is the strongest existing piece and it
already does the "respect the DoD" half of the proposal.

**F5 — DoD persistence is a documented hand step, with one instance.** `docs/explorations/triage-automation/triage-verifier.md`:
"The durable record is an issue comment. The accepted DoD replaces the body, which is what an
implementer reads." #139 is the only worked example: its body now carries the original DoD, a
second "verified against the tree" DoD, and a verifier note at the top. No code writes to the
tracker. Comments are invisible to `gh issue view`, so a comment cannot be the DoD an implementer
reads — the body is right, and the docs already say so.

**F6 — The batch on the tracker is eight tickets, all already carrying DoDs.** #163–#170 from the
2026-10-31 architecture review (C1–C8). Five `ready-for-agent` (#163, #164, #165, #168, #169), three
`needs-info` (#166, #167, #170) with the blocking decision written in the body. Every `src/` path
the eight bodies cite exists at HEAD (checked by extracting paths and testing with `-e`; HEAD is one
docs-only commit after their `6e39a2e` base).

**F7 — Those DoDs are self-authored and unverified.** Written by the session that wrote the tickets
and checked their claims, so they are not valid blind-test subjects for `docs/explorations/triage-automation/triage-prompt.md`
(which requires an unverified issue) but they are exactly the input the verifier pass exists for.

**F8 — "A DoD exists" does not imply "doable".** #166 states "Needs one decision before
implementation; until it is answered this ticket is not AFK-ready" and still carries five criteria.
The label, not the DoD, carried the blockage. #167 and #170 are product decisions (absent-vs-zero,
record-vs-re-derive) that change published numbers; their DoDs survive either answer. So the binary
"doable / not doable" is coarser than the real thing: some decisions block a criterion's exact
shape, not the whole DoD.

**F9 — A batch is serial by construction.** `src/runtime/runtime.ts` is named by #163, #164, #166 and
#168; `src/peer/peer-harness.ts` by #165 and #170; `src/scorecard/scorecard.ts` by #167 and #170.

**F10 — Batch is an open question in the source documents.** `docs/explorations/triage-automation/triage-loop-brief.md:110`
question 1: "Is the loop's unit one issue, or a batch? Must the phase finish before any run starts?"
Restated at `docs/temp-handoffs/04-triage-run-type-handoff.md:49`.

**F11 — "One config for all tickets" collides with the gate.** Because the gate compares attester
criteria against the manifest's DoD array (F4), one static manifest cannot serve tickets with
different DoDs. What can be shared per batch is roster, models and validation; the DoD must be
materialized into a per-ticket manifest. No document says this, and it is the constraint most likely
to be missed.

**F12 — One config also collides with D5.** The verifier must run on a different model family from
the author (`docs/explorations/triage-automation/triage-verifier.md`, "How to run it"), and all prompt evidence is single-family
(brief, R4). The batch config is therefore at least two phases on two families. The schema knows
only per-agent `model` strings, not families.

**F13 — Nothing writes the ticket, and #139 shows the hazard.** #139 now holds two DoD sections with
no stated rule for which is authoritative. Any driver that reads "the DoD" out of a body must pick.

## Risks (R)

- **R1** DoD text travelling body → manifest → attester is a transform. #118 was exactly this class
  of failure (inline-code markers dropped, byte compare, run failed). `normalizeCriterion` covers
  backticks, quote styles, dashes and whitespace only.
- **R2** Batch selection by label is unenforced: nothing sets or clears `ready-for-agent`, and 50
  closed issues carried it (brief, "The enforcement gap"). The eight-ticket batch is exactly as
  trustworthy as that label.
- **R3** "Zero false matches" is calibrated on tables of 6 and 2 rows and has never checked a real
  report inside a real cycle (brief, R1).
- **R4** Triage cost is 60–95k tokens per issue at figures the prior handoff already flags as stale;
  the order of magnitude holds, the numbers are not current.

## Open questions that block a build (Q)

- **Q1** Does the driver write the report's DoD verbatim into the manifest, or parse it out of the
  ticket body? F3 forecloses "the run reads the ticket", so one of these is forced.
- **Q2** Where does the driver live — justfile recipe, script, or new run type? The prior handoff
  lists three homes and chose none; only the third needs schema work.
- **Q3** Who writes the DoD into the ticket, and does the original body survive the write (F13, R1)?
- **Q4** Is the verifier a launch gate or advice? "One mismatch means not accepted" is still a
  sentence a human applies.
- **Q5** What ends the batch: ticket count, spend, or first failure?

## Answer to "what is the smallest next step"

Not the prompts — they exist and are measured. Not the gate — it already checks a
criterion-per-verdict DoD. The missing piece is the driver: read a ticket, run triage, run the
verifier, refuse on mismatch, write the accepted DoD to the body and to a generated per-ticket
manifest. Do not start from "a new run type": F11 means per-ticket manifests are needed either way,
and F3 means no supervisor can fetch its own ask.

## What this review did not check

- No live triage or verifier run was executed; F1/F2 are the recorded evidence, not new measurement.
- Ticket line numbers were not re-derived one by one; only cited `src/` paths were checked for
  existence at HEAD. Individual `path:line` citations inside #163–#170 remain as verified at
  `6e39a2e` and are unverified at `80604e1`.
- Label history was not inspected: who applied `ready-for-agent` to #163–#170 and when is assumed
  from the prior handoff, not from the tracker's timeline.
- The claim that #139's two DoD sections were never reconciled is read off the body only; no
  comment or timeline entry was inspected to confirm intent.

## Pointers

- Decision record and open frontier: `docs/explorations/triage-automation/triage-loop-brief.md` (D1–D9, R1–R6, 8 questions).
- Prior handoff: `docs/temp-handoffs/04-triage-run-type-handoff.md` (inherited state, three candidate
  homes, where code would go).
- Prompts: `docs/explorations/triage-automation/triage-prompt.md`, `docs/explorations/triage-automation/triage-verifier.md`.
- Evidence: `docs/explorations/triage-automation/evidence/triage-prompt-2026-10-29.md`,
  `docs/explorations/triage-automation/evidence/triage-verifier-calibration-2026-10-30.md`.
- Tickets: #163–#170 open. #139 is the one worked persistence example.
- Code touched by the argument: `src/contracts/session-schema.ts:112-119`,
  `src/supervisor/finalization.ts:78-122`, `src/pi/extension.ts:416-623`,
  `src/pi/supervisor-prompt.md`.
- Vocabulary: `GLOSSARY.md`. Labels: `docs/agents/triage-labels.md`. Tracker conventions:
  `docs/agents/issue-tracker.md` (comments posted during triage carry the AI-generated disclaimer,
  `.agents/skills/triage/SKILL.md`).
