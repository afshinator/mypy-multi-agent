# The triage loop: state and open questions

Material for a grilling session. The subject is a loop that takes GitHub issues and gets them
done with some faith in correctness, when the Definition of Done (DoD) is not known in advance.
Nothing here is settled until you say so: the decisions marked **D** are ones this project
made, and several of them are the agent's, not yours.

## The subject in one paragraph

Today one **run** does one **ask**. An issue in the tracker is not a run, and the DoD is the
part that is missing: an issue says what is wrong, not what a later session must prove. The
proposed loop inserts a phase before the run: find out what is true about the issue, decide
whether the change it asks for is real and reachable, write the DoD from that, and only then
either make a run or do the work inline. A second phase checks the first phase's output,
because a triage report is a claim like any other. The parts that exist are **text**: two
prompt documents and two evidence documents. No code runs them.

## What exists, and what it cost

- **`docs/explorations/triage-automation/triage-prompt.md`** — the phase that produces a DoD. Nine runs have used it, each in
  its own disposable clone, read-only, no run and no pane. Eight returned no DoD (with the
  reason), one produced a six-criterion DoD and chose `inline`. Every stop's load-bearing row
  was re-checked by hand. Cost across the nine: 199 turns, roughly 600k tokens,
  ~60–95k tokens per issue.
- **`docs/explorations/triage-automation/triage-verifier.md`** — the pass that checks the report. One fresh agent on a
  different model family, given only the claim table, re-runs each row's command and returns
  one verdict per row. Calibrated on two tables with known defects: every defect refused,
  including two rows believed sound, and **zero false matches**. Cost: 6 turns, ~20k tokens.
- **`docs/explorations/triage-automation/evidence/triage-prompt-2026-10-29.md`** and
  **`docs/explorations/triage-automation/evidence/triage-verifier-calibration-2026-10-30.md`** — the measurements, and what
  they do not show.
- **The tracker.** None of this phase's own tickets is open. #139 (DoD written and verified)
  shipped its two markdown files in `69efdfc`; #138 shipped in `6e39a2e`; #125 was closed by
  decision with a re-measurement and a machine config (`~/.pi/agent/subagent-models.json`),
  no repo change. The open set is #163–#170, the eight tickets from the 2026-10-31
  architecture review, catalogued in `docs/temp-handoffs/04-triage-run-type-handoff.md`.

## Settled decisions (D)

- **D1 — the phase's goal is the investigation, not the DoD.** A DoD is what a clean walk
  produces. Learned from run 2, which hit a fix that could not work, repaired it, and returned
  `run` for five criteria describing a change nobody approved.
- **D2 — each step has its own exit, and one of them is not "any problem".** All of `partial`
  stops everything. Evidence: five subjects recorded three to five `partial` verdicts each
  (stale line numbers, moved symbols) and went on to a verdict anyway. Two of those were the
  correct outcome.
- **D3 — a DoD is checked six ways before it is accepted**: vacuous, off-surface, partial,
  contradictory, unverifiable by construction, off-ask. Each came from a ticket in this repo.
- **D4 — read-only is a capability, not a promise.** The phase needs `bash`, so it runs in a
  `cp -Rc` clone. A `bash` child runs in its own worktree under
  `$CLONE/.git/subagents/<run>/<task>`, so paths must be absolute.
- **D5 — the verifier sees the claim table and nothing else**, samples by a rule fixed in
  advance, and returns the repo's verdict-block shape. An undecidable row is a mismatch.
- **D6 — one mismatch means the DoD is not accepted.** A wrong `match` is what admits a false
  claim to a run; a wrong `mismatch` costs a re-investigation.
- **D7 — the prompt is for an agent that is not a peer**: no roster, no bus, no attester. The
  DoD it writes is for a later run.
- **D8 — the industry-standard warning was removed and the protocol kept.** Telling the agent
  that tickets here are wrong was unnecessary; the four steps found the same errors for less.
- **D9 — counters age out.** A byte or call count is unverifiable once its artifact changes.
  Stamp counters with the artifact and the time.

## The enforcement gap

This is the answer that prompted this document, kept as it was given.
- Nothing runs the prompts. No script, no `justfile` recipe, no supervisor, no peer. A human
  copies the fenced block into a subagent call. That was the agent, nine times.
- No test reads the two prompt documents. `bun run check` only proves that the links inside
  them resolve, because the docs guard walks `docs/**/*.md`.
- No gate accepts or rejects a DoD. "One mismatch means not accepted" is a sentence, and a
  human applies it.
- The entry condition is unenforced. `ready-for-agent` is what a loop would trust. Nothing
  sets it and nothing clears it: **50 closed issues carried it**, including two the triage
  runs themselves flagged, and the agent cleared them by hand.
- Enforcement must live at delivery: one runner that reads the prompt, makes the clone, starts
  the phase, saves the report, samples the rows, starts the verifier, and refuses a DoD
  without a clean block. The documents are that runner's text. The runner does not exist.
- The cheapest partial step is a guard test, like the one that guards the writer prompts in
  `templates/`, that fails when either prompt loses a required clause. That stops a silent
  edit. It does not enforce the process.

## Not proven (R)

- **R1 — the loop has never run end to end.** The verifier is calibrated on two toy tables and
  has never checked a real report inside a real cycle. The acceptance path is unexercised.
- **R2 — the prompt has never been tested on a fresh issue with an unmet need that nobody
  rewrote.** The one DoD came from a body this project authored itself.
- **R3 — one variant is untested:** the same prompt with the six refusal criteria removed.
- **R4 — single-family evidence.** All nine triage runs used one model family. Only the
  verifier used a different one.
- **R5 — a report can be verified as wrong and then corrected by the same project.** That
  happened twice (#139's citations, #125's overstatement). The correction was not itself
  verified.
- **R6 — per-issue cost is 60–95k tokens of triage plus ~20k of verification**, before any run
  spends anything. For a docs-only issue that is close to the work itself.

## What is next (A)

- **A1 — run the cycle end to end on one real issue**: triage, then verify, then accept or
  reject. This is what R1 asks for and it is cheap.
- **A2 — decide where the runner lives** and build it, or decide explicitly not to. This is
  the only place enforcement can live.
- **A3 — implement #139** from its written DoD: two markdown files, `inline`, no run.
  **Done** — `69efdfc`.
- **A4 — settle the two `needs-info` issues.** #138 needed "upstream pi or in-repo
  interception" and shipped in-repo (`6e39a2e`); #125 needed "upstream the extension, or
  close" and was closed without an upstream issue. **Done.**
- **A5 — make `ready-for-agent` mean something** or stop treating it as the loop's entry.
- **A6 — test variant R3** (no refusal criteria) when a suitable issue appears.

## The unsettled frontier

The questions a grill should ask, in the order they block each other. None of these is decided.
1. Is the loop's unit one issue, or a batch? Must the phase finish before any run starts?
2. Where does the runner live: a shell loop, a `justfile` recipe, a supervisor prompt, or a
   new peer in a run?
3. Does the phase write the DoD, or only a verdict — with the run's supervisor writing the DoD
   from that verdict?
4. Is the verifier a gate or advice? If a gate, who arbitrates when author and verifier
   disagree about the same command's output?
5. Who takes the `run` or `inline` branch, and on what rule?
6. What is the per-issue bound, and what stops the loop? Which threshold?
7. Should closed issues be triaged at all? Two runs stopped with "already done" (N5).
8. Is the loop allowed to touch the tracker — labels, bodies, comments — or only read it?

## Pointers

- Prompt: `docs/explorations/triage-automation/triage-prompt.md`. Verifier: `docs/explorations/triage-automation/triage-verifier.md`.
- Evidence: `docs/explorations/triage-automation/evidence/triage-prompt-2026-10-29.md`,
  `docs/explorations/triage-automation/evidence/triage-verifier-calibration-2026-10-30.md`.
  The retro's S2 correction is commit `1e359aa`.
- House rules for prompts: `docs/agent-config-guide.md` §10.
- Runs and their artefacts: `mypi-tasks/*/run-details/` — frozen, never edited.
- Tickets: #163–#170 open (the 2026-10-31 architecture-review batch). Commits of note: `8ed3791` (verifier), `720e8d7` (nine
  runs), `1e359aa` (retro correction), `1fd5448` (replaced-peer marking), `8fd93b9` (writer
  and supervisor prompt rules), `69efdfc` (#139), `6e39a2e` (#138).
- Vocabulary: `GLOSSARY.md`. A run, a peer, a roster and a verdict block all mean what it says
  there; the triage phase is none of those.
