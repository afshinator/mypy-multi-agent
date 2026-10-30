# Issue → Definition of Done: the triage prompt

The prompt below is given to one fresh agent to turn a GitHub issue into a Definition of Done (DoD) that a later session can execute. It is the first phase of the loop: issue → claims checked → DoD written, or a refusal to write one.

Two tests have run with it. What they showed, and what changed, is at the end of this file.

## The prompt

Copy everything inside the fence. Replace `#NNN` with the issue number. Nothing else is given to the agent: no conversation, no hint that the issue may be wrong.

```text
You are working in the repository at /Users/afshin/Documents/dev/multi-agent.

Read these first: `.agents/skills/triage/SKILL.md`, `docs/agents/issue-tracker.md`, `docs/agent-config-guide.md` §10.

Your assignment is GitHub issue #NNN. Read it with `gh issue view NNN`.

Do not implement anything. Do not create, edit or delete any file. Read-only.

Follow this protocol, in order. Do not skip a step. Run a command for every check and record what it returned.

1. VERIFY THE FACTS. Every factual statement in the issue — file, line, incident, code path, claimed behaviour — is checked with a command you run. Record the claim, the command, the observed result, and a verdict of true, partial or false.
2. VERIFY THE NEED. Name the mechanism the issue blames. Check that the mechanism is on the path where the incident happened. Show the line that proves it. A gap that exists on a path the incident never used is not the gap the issue describes.
3. VERIFY THE FIX. Show what the code already does, what is missing, and the surface a change must touch. If the proposed change does not reach the mechanism from step 2, say so.
4. WRITE THE DEFINITION OF DONE. Numbered criteria, each falsifiable, each naming how a later session proves it.

If the fix in the issue cannot reach the mechanism, the DoD CANNOT be written. Do not repair the fix and do not write criteria for a different change. Say `Not writable:` with the N-code below and stop. You may state in one paragraph what a working change would need, but it does not belong in the DoD — the issue must go back for triage before any agent executes it.

The DoD also cannot be written when any of these hold:
- N1 a criterion cannot be expressed as a check a later session can run;
- N2 the subject surface of the change cannot reach the failing path;
- N3 the change needs a fact that does not exist yet and cannot be created now;
- N4 two criteria contradict each other, so no work order can satisfy both;
- N5 the need is already met, so the issue should be closed rather than written.

Output exactly these sections as terse markdown, no preamble:
## Claim checks
A table: claim | command | observed | verdict (true/partial/false). One row per checkable claim.
## Need
The blamed mechanism, the path the incident took, and the line that proves it.
## Fix
What exists, what is missing, the surface a change must touch, and whether it reaches the mechanism from Need.
## Definition of Done
Numbered criteria, each with its proof. Or the single line `Not writable:` followed by the N-code and the reason.
## Verdict
`run` or `inline`, justified by the size and shape of the change rather than by ceremony. A run uses several peers, costs real money and takes 15+ minutes, so `inline` is correct whenever it is defensible.
## Open questions
Anything a human must answer before this issue can be executed. Write `none` if there is nothing.
```

### How to run it

- One fresh agent, no prior context, read-only tools (`read`, `bash`, `grep`, `find`, `ls`).
- A ticket is a valid test subject only if its claims have not been verified already. A ticket that is already settled cannot fail the test.
- The judge (a human, or a session that knows the answer) must re-check the load-bearing claims by hand. Both tests so far contained at least one wrong claim from the agent itself: test one reported 1043 tests where the suite runs 1037 and cited `restartAgent` at the wrong line; test two left one premise unverified.
- Success is not "a DoD was produced". Success is that every claim row is backed by a command, and that a refusal, when one is due, is taken instead of repaired.

## What the two tests showed

**Test one, issue #135, with a warning.** The prompt said tickets in this repo routinely assert false things. The agent found that the issue blamed a resume order for an incident with zero resume events, and proved the briefing renders only in the `--resume` branch. Cost: 36 turns, ~100k tokens.

**Test two, issue #132, warning removed.** The protocol alone found a false count ("three concurrent full-suite runs" — there were two, and the slow one was contention with `npx vitest`, not with another suite) and proved the issue's fix cannot work: `tool-permissions.ts:22` matches commands by exact string, `:21` lets any edit-capable peer skip the allowlist, and `session-schema.ts:179` gives the vocabulary only to read-only peers. The peer that ran `npx` was edit-capable. Cost: 21 turns, ~87k tokens.

Conclusion: the warning is unnecessary. The protocol produces the findings.

**The failure it exposed.** Asked to write a DoD, test two hit a fix that could not work — and repaired it instead. It dropped the broken clause, added the machinery needed to make the rest work, and wrote five criteria for that repaired change, returning `run`. Its `Fix` section said the proposal does not reach the mechanism, so it was not silent; the abort branch simply lost to the urge to be useful.

That is why step 4 now carries the explicit no-repair clause. "Can a DoD be written" is always yes, because a capable agent can always invent a different change. The real question is "can a DoD be written for the fix _this issue_ asks for", and the prompt must say so.

**Still unprompted, and a known limit.** The N1–N5 list names the failure shapes, and N2 in particular describes the shape test two's headline finding took. The claim checks were unprompted; the refusal judgement is partly prompted. A third variant that drops N1–N5 would test whether an agent reaches the refusal on its own.

## The next test

- **A — the normal path.** Run the prompt on an issue whose claims are unverified and whose fix is sound. It must produce a numbered DoD, must not take the abort branch, and every claim row must carry a command. Issue #139 is a candidate once its current text is the subject of interest.
- **B — the abort branch.** Run the prompt on an issue whose fix cannot reach the failing path. It must return `Not writable:` with the N-code and no DoD. No ticket of that kind is open today; #132 was that case and its body now says so, which makes it useless as a blind subject.
- **C — the no-list variant.** Variant A with N1–N5 removed, to see whether the refusal survives without being described.

Each test is one agent, one issue, read-only, no run.
