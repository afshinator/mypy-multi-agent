# Issue → Definition of Done: the triage prompt

The prompt below investigates one GitHub issue: what is true about it, whether the need is
real, and whether the fix it asks for is reachable. If all three hold, it writes the
criteria a later run will be checked against. If any of them does not, it reports what it
found and ends there.

Two tests have run with it; their measured outcome is in
`docs/evidence/triage-prompt-2026-10-29.md`. The short version: the investigation finds
false claims without being warned about them, and an agent whose objective is a DoD will
repair a broken fix rather than report it — which is why the output is conditional.

## The prompt

Copy everything inside the fence. Replace `#NNN` with the issue number. Give the agent
nothing else — no conversation, no hint that anything in the issue is wrong.

```text
SITUATION
This repository runs work as a run: a supervisor directs a roster of peers, and the run is
judged against a Definition of Done (DoD). You come first. You find out what is true about
one issue, and whether the change it asks for is real and reachable. If it is, you write
the criteria a later run will be checked against. If it is not, you report what you found
and why, and that is a complete answer.
Nobody has verified this issue. Its file, line, incident and behaviour claims are claims
until a command you ran says otherwise. You receive the issue text and nothing else: no
earlier conversation, no conclusions from previous sessions, no hint that any particular
claim is wrong.
Work in /Users/afshin/Documents/dev/multi-agent. Read these first:
`.agents/skills/triage/SKILL.md`, `docs/agents/issue-tracker.md`,
`docs/agent-config-guide.md` §10.

FUNCTION AND ARTIFACT
The artifact you own is your reply: the sections below. You write no file, change no code,
and start nothing — read-only tools only (`read`, `bash`, `grep`, `find`, `ls`). Your
assignment is GitHub issue #NNN; read it with `gh issue view NNN`.

Work in this order, and run a command for every check. Each step exists so the next one is
not built on something untrue.

1. WHAT IS TRUE. Check every factual statement in the issue — file, line, incident, code
   path, claimed behaviour — with a command you run. Record the claim, the command, the
   observed result, and true / partial / false. Wrong citations are normal: record
   `partial` with the correct location and carry on. Nothing here is a reason to stop.
2. IS THE NEED REAL. Name the mechanism the issue blames. Check that the mechanism is on
   the path the incident actually took, and show the line that proves it. A gap on a path
   the incident never used is not the gap the issue describes.
3. IS THE FIX REAL. Say what the code already does, what is missing, and the surface a
   change must touch. Does the change the issue asks for reach the mechanism from step 2?
4. WRITE THE DoD — only if both 2 and 3 hold. Numbered criteria, each falsifiable, each
   naming how a later session proves it.
5. CHECK THE DoD. Re-read every criterion. Each must fail on today's tree, must fail unless
   the surface from step 3 changed in the way step 3 described, and must be checkable by a
   later session with what that session can actually see. The DoD is wrong when any of
   these holds:
   - it already passes on today's tree, with no change made: the criterion is vacuous, or
     the issue needs nothing;
   - it can pass without touching the surface from step 3;
   - it covers part of the issue and not the rest;
   - two criteria cannot both hold;
   - its proof names evidence no artifact records — "a later session's log shows …";
   - it asks for work the issue does not request.
   Report the criterion and which one it is.

STAKES AND CONSUMER
A human reads your reply and decides whether this issue is executed, and how. A wrong
"this is fine" buys a run: several peers, 15+ minutes, real money. Criteria for a change
the issue does not ask for send an implementer to a surface nobody approved — that is the
`04-inspector-server` rework, which cost three dispatches. So `inline` beats a run whenever
it is defensible, and "the issue does not support a DoD" is a useful answer, not a failure.

WHEN THE ISSUE DOES NOT SUPPORT A DoD
When step 2 or step 3 does not hold, or the step-5 check fails, your reply ends there.
Report what you found, why it does not support a DoD, and which of these it is:
- N1 a criterion cannot be expressed as a check a later session can run;
- N2 the change cannot reach the failing path;
- N3 the change needs a fact that does not exist yet and cannot be created now;
- N4 two criteria cannot both hold;
- N5 the need is already met, so the issue should be closed instead.
Write no criteria, and do not write criteria for a different change.

Output exactly these sections as terse markdown, no preamble. Keep the whole reply inside
one round trip: no section longer than a screen.
## Claim checks
A table: claim | command | observed | verdict (true/partial/false). One row per checkable
claim, and no row without a command behind it.
## Need
The blamed mechanism, the path the incident took, the line that proves it, and whether the
need holds.
## Fix
What exists, what is missing, the surface a change must touch, and whether it reaches the
mechanism from Need.
## Definition of Done
Numbered criteria, each with its proof — or, when a step does not hold, the single line
`No DoD: <N-code and reason>`.
## Verdict
`run` or `inline`, justified by the size and shape of the change rather than by ceremony —
or `no DoD`.
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
  no step was skipped, and that a finding which blocks a DoD is reported instead of worked
  around.
- Watch for the opposite error too: a **false stop** on a harmless finding. A citation off
  by a line is a `partial` row, not a blocked DoD.

### The next tests

- **A — a healthy issue.** Unverified claims, sound fix. It must produce a numbered DoD.
  #139 is a candidate once its own text is the subject of interest.
- **B — an issue whose fix cannot reach the failing path.** It must report `No DoD` with the
  N-code and write no criteria. No ticket of that kind is open today: #132 was that case,
  and its body now says so, which makes it useless as a blind subject.
- **C — a harmless defect.** An issue whose only flaw is a citation off by a line. It must
  record `partial`, continue, and produce a DoD. This tests the false-stop risk.
- **D — no N-codes.** Test A with the N1–N5 list removed, to see whether the `No DoD` answer
  survives without being described.

Each test is one agent, one issue, read-only, no run.

## Conformance with §10 of the agent-config guide

The prompt is a pi subagent's task text, not a peer's `system_prompt`, so §10 step 5's four
slots are applied as slots in the text. Where each slot sits:

| §10 slot                      | In this prompt                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| R1 Situation                  | the `SITUATION` block: the run it feeds, what it receives, what it must not assume, and the files to read                                  |
| R2 Function and artifact      | the `FUNCTION AND ARTIFACT` block: the reply is the owned artifact, read-only, and the five ordered steps are the function                 |
| R3 Stakes and consumer        | the `STAKES AND CONSUMER` block: a human decides from this reply, a wrong "this is fine" costs a real run, and `No DoD` is a useful answer |
| R4 Stop conditions and format | the `WHEN THE ISSUE DOES NOT SUPPORT A DoD` block: where the reply ends, the N-codes, and the six sections                                 |

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
