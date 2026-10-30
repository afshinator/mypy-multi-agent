# Issue → Definition of Done: the triage prompt

The prompt below decides whether one GitHub issue has a clean path to a Definition of Done
(DoD), and produces that DoD only when the path is clean. It is the first phase of the
loop: issue → paths walked → DoD, or a stop with the reason.

Two tests have run with it; their measured outcome is in
`docs/evidence/triage-prompt-2026-10-29.md`. The short version: the protocol finds false
claims without being warned about them, and an agent asked to produce a DoD will repair a
broken fix rather than refuse — which is why the objective below is the walk, not the DoD.

## The prompt

Copy everything inside the fence. Replace `#NNN` with the issue number. Give the agent
nothing else — no conversation, no hint that anything in the issue is wrong.

```text
SITUATION
This repository runs work as a run: a supervisor directs a roster of peers, and the run
is judged against a Definition of Done (DoD). You are the phase before that: you decide
whether this issue has a clean path to a DoD at all. Nobody has verified this issue — its
file, line, incident and behaviour claims are claims until a command you ran says
otherwise. You receive the issue text and nothing else: no earlier conversation, no
conclusions from previous sessions, no hint that any particular claim is wrong.
Work in /Users/afshin/Documents/dev/multi-agent. Read these first:
`.agents/skills/triage/SKILL.md`, `docs/agents/issue-tracker.md`,
`docs/agent-config-guide.md` §10.

FUNCTION AND ARTIFACT
The artifact you own is your reply: the sections below. You write no file, change no code,
and start nothing — read-only tools only (`read`, `bash`, `grep`, `find`, `ls`). Your
assignment is GitHub issue #NNN; read it with `gh issue view NNN`.

YOUR GOAL IS TO WALK THE PATHS BELOW FAITHFULLY. The DoD is what a clean walk produces. It
is not the goal, and a DoD written without a clean walk is a failed task even when it reads
well. Do not skip a path, do not let a later path cover for an earlier one, and run a
command for every check.

PATH 1 — VERIFY THE FACTS. Every factual statement in the issue — file, line, incident,
code path, claimed behaviour — is checked with a command you run. Record the claim, the
command, the observed result, and a verdict of true, partial or false.
Exit: always clean. A wrong citation is not a reason to stop: record `partial` with the
correct location and continue.

PATH 2 — VERIFY THE NEED. Name the mechanism the issue blames. Check that the mechanism is
on the path where the incident happened, and show the line that proves it.
Exit clean: the blamed mechanism is on that path (N5 does not hold).
Exit STOP: the mechanism is not on the path the incident took. A gap that exists on a path
the incident never used is not the gap the issue describes.

PATH 3 — VERIFY THE FIX. Show what the code already does, what is missing, and the surface
a change must touch.
Exit clean: the proposed change reaches the mechanism from path 2, and the surface it must
touch is named.
Exit STOP: it does not reach that mechanism.

PATH 4 — WRITE THE DEFINITION OF DONE. Only reachable if paths 2 and 3 both exited clean.
Numbered criteria, each falsifiable, each naming how a later session proves it.

PATH 5 — CHECK THE DoD AGAINST THE PATH. Re-read every criterion and ask: if a later
session does exactly this, has it fixed the need from path 2, on the surface from path 3?
Exit clean: every criterion fails unless that surface changed in the way path 3 described.
Exit STOP: a criterion could pass without touching that surface. Report which criterion
and what it misses. Do not patch it.

STAKES AND CONSUMER
A human reads your reply and decides whether this issue is executed, and how. A wrong
continuation buys a run: several peers, 15+ minutes, real money. A DoD written for a change
the issue does not ask for sends an implementer to a surface nobody approved — that is the
`04-inspector-server` rework, which cost three dispatches. So a stop is a success when a
path cannot continue, `inline` is correct whenever it is defensible, and a plausible DoD is
never a reason to continue past a STOP.

STOP CONDITIONS AND FORMAT
Stop at the first path whose exit is STOP. Your reply then reports which path, the
evidence, why it cannot continue, and what would have to change for it to. Do not produce a
DoD, do not offer a replacement fix as a DoD, and do not continue in order to be helpful.

A path also stops when any of these holds:
- N1 a criterion cannot be expressed as a check a later session can run;
- N2 the subject surface of the change cannot reach the failing path (path 3);
- N3 the change needs a fact that does not exist yet and cannot be created now;
- N4 two criteria contradict each other, so no work order can satisfy both (path 5);
- N5 the need is already met, so the issue should be closed rather than written (path 2).

Output exactly these sections as terse markdown, no preamble. Keep the whole reply inside
one round trip: no section longer than a screen.
## Claim checks
A table: claim | command | observed | verdict (true/partial/false). One row per checkable
claim, and no row without a command behind it.
## Need
The blamed mechanism, the path the incident took, the line that proves it, and the exit.
## Fix
What exists, what is missing, the surface a change must touch, whether it reaches the
mechanism from Need, and the exit.
## Definition of Done
Numbered criteria, each with its proof — or, when a path stopped, the single line
`Stopped at path N: <reason>` and nothing else.
## Verdict
`run` or `inline`, justified by the size and shape of the change rather than by ceremony —
or `stopped`, when a path stopped.
## Open questions
Anything a human must answer before this issue can be executed. Write `none` if there is
nothing.
```

### How to run it

- One fresh agent, no prior context, read-only tools (`read`, `bash`, `grep`, `find`, `ls`).
- A valid test subject is an issue whose claims have **not** been verified already. A
  settled issue cannot fail the test.
- The judge re-checks the load-bearing claim rows by hand. Both tests so far contained at
  least one wrong claim from the agent itself.
- Success is not "a DoD was produced". Success is that every row carries a command, that
  no path was skipped, and that a stop, when one is due, is taken instead of repaired.
- Watch for the opposite error too: a **false stop** on a harmless finding. A citation off
  by a line is a `partial` row, not an exit.

### The next tests

- **A — the clean path.** An issue with unverified claims and a sound fix. It must produce
  a numbered DoD and must not stop. #139 is a candidate once its own text is the subject of
  interest.
- **B — the stop path.** An issue whose fix cannot reach the failing path. It must report
  `Stopped at path 3` with the N-code, and produce no DoD. No ticket of that kind is open
  today: #132 was that case, and its body now says so, which makes it useless as a blind
  subject.
- **C — the false stop.** An issue whose only defect is a harmless citation error. It must
  record `partial`, continue, and produce a DoD. This tests the risk the path framing
  introduces.
- **D — the no-criteria variant.** Test A with N1–N5 removed, to see whether a stop
  survives without being described.

Each test is one agent, one issue, read-only, no run.

## Conformance with §10 of the agent-config guide

The prompt is a pi subagent's task text, not a peer's `system_prompt`, so §10 step 5's four
slots are applied as slots in the text. Where each slot sits:

| §10 slot                      | In this prompt                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 Situation                  | the `SITUATION` block: the run it feeds, what it receives, what it must not assume, and the files to read                                     |
| R2 Function and artifact      | the `FUNCTION AND ARTIFACT` block: the reply is the owned artifact, read-only, and the goal — walk the paths — with paths 1–5 as the function |
| R3 Stakes and consumer        | the `STAKES AND CONSUMER` block: a human decides from this reply, a wrong continuation costs a real run, and a stop is a success              |
| R4 Stop conditions and format | the `STOP CONDITIONS AND FORMAT` block: stop at the first STOP exit, N1–N5, and the six sections                                              |

Deliberate deltas from §10, and why:
- **No roster, no bus, no verdict block, no attester.** This is one read-only agent, not a
  peer in a run. The DoD it writes is for a _later_ run, not for its own work order.
- **The writer rule does not apply.** §10 R2 requires every `edit: true` peer's prompt to
  state how it changes a file. This prompt has no edit rights at all, which is the point: a
  triage agent that can write is a triage agent that can implement.
- **R1 carries a must-not-assume clause, not a warning.** §10 asks R1 to state what the
  agent must not assume, so the prompt says the issue's claims are claims until a command
  says otherwise. The removed warning asserted something about this repository's tickets
  ("they routinely assert false things"); it was unnecessary, as the evidence file shows,
  and it is a claim the agent cannot check.
- **Reply sized to one round trip.** §10 R4 warns that long output truncates silently. Six
  sections, tables, one screen each.
