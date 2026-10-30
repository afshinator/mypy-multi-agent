# Issue → Definition of Done: the triage prompt

The prompt below turns one GitHub issue into a Definition of Done (DoD) a later session
can execute, or refuses when the issue cannot support one. It is the first phase of the
loop: issue → claims checked → DoD written, or a refusal.

Two tests have run with it. Their measured outcome is in
`docs/evidence/triage-prompt-2026-10-29.md`; the short version is that the protocol finds
false claims without being warned about them, and that the refusal needed an explicit
clause after an agent repaired a broken fix instead.

## The prompt

Copy everything inside the fence. Replace `#NNN` with the issue number. Give the agent
nothing else — no conversation, no hint that anything in the issue is wrong.

```text
SITUATION
This repository runs work as a run: a supervisor directs a roster of peers, and the run
is judged against a Definition of Done (DoD). You are the phase before that: you decide
whether this issue can become a DoD at all. Nobody has verified this issue — its file,
line, incident and behaviour claims are claims until a command you ran says otherwise.
You receive the issue text and nothing else: no earlier conversation, no conclusions
from previous sessions, no hint that any particular claim is wrong.
Work in /Users/afshin/Documents/dev/multi-agent. Read these first:
`.agents/skills/triage/SKILL.md`, `docs/agents/issue-tracker.md`,
`docs/agent-config-guide.md` §10.

FUNCTION AND ARTIFACT
The artifact you own is your reply: the six sections below. You write no file, change
no code, and start nothing — read-only tools only (`read`, `bash`, `grep`, `find`, `ls`).
Your assignment is GitHub issue #NNN; read it with `gh issue view NNN`.
Follow this protocol in order. Do not skip a step, and run a command for every check.

1. VERIFY THE FACTS. Every factual statement in the issue — file, line, incident, code
   path, claimed behaviour — is checked with a command you run. Record the claim, the
   command, the observed result, and a verdict of true, partial or false.
2. VERIFY THE NEED. Name the mechanism the issue blames. Check that the mechanism is on
   the path where the incident happened. Show the line that proves it. A gap that exists
   on a path the incident never used is not the gap the issue describes.
3. VERIFY THE FIX. Show what the code already does, what is missing, and the surface a
   change must touch. If the proposed change does not reach the mechanism from step 2,
   say so.
4. WRITE THE DEFINITION OF DONE. Numbered criteria, each falsifiable, each naming how a
   later session proves it.

STAKES AND CONSUMER
A human reads your reply and decides whether this issue is executed, and how. A wrong
`run` verdict buys a run: several peers, 15+ minutes, real money. A DoD written for a
change the issue does not ask for sends an implementer to a surface nobody approved —
that is the `04-inspector-server` rework, which cost three dispatches. So `inline` is
correct whenever it is defensible, and a refusal is a success when the fix cannot reach
the failing path.

STOP CONDITIONS AND FORMAT
If the fix in the issue cannot reach the mechanism, the DoD CANNOT be written. Do not
repair the fix, and do not write criteria for a different change. Say `Not writable:`
with the N-code below and stop. You may say in one paragraph what a working change would
need, but it does not belong in the DoD — the issue must go back for triage before any
agent executes it.

The DoD also cannot be written when any of these hold:
- N1 a criterion cannot be expressed as a check a later session can run;
- N2 the subject surface of the change cannot reach the failing path;
- N3 the change needs a fact that does not exist yet and cannot be created now;
- N4 two criteria contradict each other, so no work order can satisfy both;
- N5 the need is already met, so the issue should be closed rather than written.

Output exactly these sections as terse markdown, no preamble:
## Claim checks
A table: claim | command | observed | verdict (true/partial/false). One row per checkable
claim, and no row without a command behind it.
## Need
The blamed mechanism, the path the incident took, and the line that proves it.
## Fix
What exists, what is missing, the surface a change must touch, and whether it reaches the
mechanism from Need.
## Definition of Done
Numbered criteria, each with its proof. Or the single line `Not writable:` followed by the
N-code and the reason.
## Verdict
`run` or `inline`, justified by the size and shape of the change rather than by ceremony.
## Open questions
Anything a human must answer before this issue can be executed. Write `none` if there is
nothing. Keep the whole reply inside one round trip: no section longer than a screen.
```

### How to run it

- One fresh agent, no prior context, read-only tools (`read`, `bash`, `grep`, `find`, `ls`).
- A valid test subject is an issue whose claims have **not** been verified already. A
  settled issue cannot fail the test.
- The judge re-checks the load-bearing claim rows by hand. Both tests so far contained at
  least one wrong claim from the agent itself.
- Success is not "a DoD was produced". Success is that every row carries a command, and
  that a refusal, when one is due, is taken instead of repaired.

### The next tests

- **A — the normal path.** An issue with unverified claims and a sound fix. The agent must
  produce a numbered DoD and must not take the abort branch. #139 is a candidate once its
  own text is the subject of interest.
- **B — the abort branch.** An issue whose fix cannot reach the failing path. The agent
  must return `Not writable:` with the N-code and no DoD. No ticket of that kind is open
  today: #132 was that case, and its body now says so, which makes it useless as a blind
  subject.
- **C — the no-list variant.** Test A with N1–N5 removed, to see whether the refusal
  survives without being described.

Each test is one agent, one issue, read-only, no run.

## Conformance with §10 of the agent-config guide

The prompt is a pi subagent's task text, not a peer's `system_prompt`, so §10 step 5's
four slots are applied to it as slots in the text, not as a system prompt. Where each
slot sits:

| §10 slot                      | In this prompt                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 Situation                  | the `SITUATION` block: the run it feeds, what it receives, what it must not assume, and the files to read                                                      |
| R2 Function and artifact      | the `FUNCTION AND ARTIFACT` block: the reply is the owned artifact, read-only, and the four-step protocol is the function                                      |
| R3 Stakes and consumer        | the `STAKES AND CONSUMER` block: a human decides from this reply, a wrong `run` costs a real run, a repaired fix sends an implementer to an unapproved surface |
| R4 Stop conditions and format | the `STOP CONDITIONS AND FORMAT` block: the no-repair clause, N1–N5, and the six sections                                                                      |

Deliberate deltas from §10, and why:
- **No roster, no bus, no verdict block, no attester.** This is one read-only agent, not a
  peer in a run. The DoD it writes is for a _later_ run, not for its own work order.
- **The writer rule does not apply.** §10 R2 requires every `edit: true` peer's prompt to
  state how it changes a file. This prompt has no edit rights at all, which is the point:
  a triage agent that can write is a triage agent that can implement.
- **R1 carries a must-not-assume clause, not a warning.** §10 asks R1 to state what the
  agent must not assume, so the prompt says the issue's claims are claims until a command
  says otherwise. The removed warning asserted something about this repository's tickets
  ("they routinely assert false things"); it was unnecessary, as the evidence file shows,
  and it is a claim the agent cannot check.
- **Reply sized to one round trip.** §10 R4 warns that long output truncates silently. Six
  sections, tables, one screen each.
