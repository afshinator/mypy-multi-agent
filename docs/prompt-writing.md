# Writing a peer prompt

The craft half of [`docs/agent-config-guide.md`](agent-config-guide.md) §10. The guide records
what this repo's schema, gates and guards require of a prompt; this file records what makes a
prompt work at all, and holds nothing that depends on this codebase. Where the two overlap, the
gate wins: a rule the guide states is enforced somewhere, and a rule this file states is advice.

## Situation first

Say where the peer sits in _this run_: what already exists, what it receives, what it must not
assume. A precondition is part of the situation, not a note beside it. A verifier whose prompt
says only "run the full suite and report GREEN/RED" runs the gates at the first inbound message,
before any code exists; writing "run only after the implementer reports a code change, else
`NOT-APPLICABLE`" is the same instruction that cannot fire early.

Opening with task mechanics instead is the common failure: the peer knows what to do and not what
it is in the middle of.

## Own an artifact, not an adjective

Name the file, document or verdict the peer owns, as ownership: "you own `test/x.test.ts` and no
other file" beats any adjective. Say what leaves the peer's hands. A role described by what it
knows ("you are an expert TypeScript engineer") specifies nothing a reviewer can check.

Only assign an artifact to a peer that can produce it. A peer with no write permission cannot
produce the file a plan gives it, and the file simply never appears.

## State the stake

Who reads the output and what breaks if it is wrong. Verification duty comes from a stake, not
from the word "carefully": a peer told its verdict releases a merge behaves differently from one
told to be careful.

## Size the reply to the output limit

Ask for a shape that fits one reply. A peer asked for one JSON object per finding silently
truncates: 120 rows were asked for and 65 arrived, then 20, recoverable only because the same peer
also emitted a line table. Batch the packet (roughly 30 rows per reply), or make the line table
the contract and the JSON a convenience.

## Anti-patterns

- Overlapping roles. Fewer peers with one clear job each.
- A peer given write access whose prompt only advises.
- Vague criteria ("good code").
- Two criteria that can both pass only under a redefinition. One task asked for "refused
  immediately" and "the existing FIFO queue untouched" in one DoD and spent two attestation
  rounds reconciling them. Write the one behaviour you want.
- Expertise adjectives in place of ownership (see below).
- A prompt whose first sentence is a constraint rather than the run's situation.

## Expertise adjectives

"You are an expert TypeScript engineer" does not improve accuracy over no persona: a 162-role,
2,410-question study found no gain (arXiv 2311.10054). Role framing that helps steers behaviour
and tone, not knowledge; Anthropic's guidance allows a single sentence, and role-_play_ gains in
reasoning came from a described stance and sequence, not a job title (arXiv 2308.07702).

Those studies measure factual QA and reasoning benchmarks, not agentic coding or supervisor
briefings. Treat this as a low-risk default with a stated rationale, not a measured win, and
record what a prompt change actually fixed rather than asserting it worked.

## Worked example

The reviewer of `mypi-tasks/09-seam-restart-check`, before and after:

```
Before (duty first, no situation):
READ ONLY, with three allowed commands and nothing else: ...

After (situation, stake, then the same constraints):
You are the reviewer on the last gate of this run. Nothing is reported as
done unless your verdict block passes, and the gate rejects it outright if
any criterion is not reproduced verbatim. Three transport and launch seams
just merged; you are the check that they changed nothing. You have no edit
rights and three exact commands, so your verdict rests on output you ran
yourself rather than on a sibling's transcript.
```
