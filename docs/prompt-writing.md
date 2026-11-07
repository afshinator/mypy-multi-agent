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

## Learnings

Violations that shipped in a template, the sentence that carried them, and the shape that
replaced them. The first two are shapes; the third is about what a rule's name is worth.

### A house noun is not an instruction

The prompt names something the authors know — a named mechanism, a document, a ledger — and
expects the peer to act on the name.
- "every change follows the smallest-complete-solution ladder" — a fresh peer does not know the
  rungs, so it reads the name and skips the rule.
- "you own the run contract and the cross-check ledger, not the source files" — two artefacts,
  neither described, one not mentioned again.
- "a command that is not a criterion's proof ... is scope creep" — "scope creep" is a judgement,
  not a boundary.

The peer has never opened the file the noun comes from, and often cannot: the document is in the
driver repo and the peer runs in the target worktree. So it either skips the sentence or invents
a meaning, and a peer that invented a meaning is indistinguishable from one that never read it.

The fix is the action and the artefact the peer can see. "Reject anything nobody asked for:
abstraction, options, new dependencies." "You keep plan.md and the cross-check matrix current;
you do not edit source files." "Run only a criterion's proof command, or a command that reads the
tree."

### Ownership spelled as possession is not a rule

"You own X, not Y" reads as authority, and a peer cannot act on authority.
- "you own the work, not the verdict"
- "you own the verdict and no file"
- "the core modules belong to your sibling; the edges that make a change real belong to you"

"Owning the verdict" does not say what to do with it, and "the edges that make a change real" is
a sentence about a feeling. The peer is left to infer the verb.

The fix puts the verb in it. "You do not decide whether it is done; the attester does." "You
decide pass or fail, and you change nothing." "Your sibling implements the core modules. You
implement what has to change around them: their callers, config, docs and tests."

### A rule named by its title is a pointer to a document the peer cannot open

A rule is stated by its title, as if a title were content. A reviewer's standards axis once
carried six of them — "one authority per rule", "a seam exists in production", "absent is not
zero", "refuse before spending", "comment the why", "a ticket's code assertion carries its
evidence" — and every title was a heading in a file the reviewer had no way to reach.

The titles are exactly the part a reader who knows the rule does not need. "A seam exists in
production" says nothing about where to look; "absent is not zero" sounds like a fact rather than
a test. The fix is one clause of substance each: "a test-only seam does not count, so a fake
hooked to a path production never takes hides the bug it was built to catch"; "a number nobody
recorded is never printed as `0`".

Where a guard exists, derive it from the substance rather than the title, so rewording back to
titles fails instead of drifting.

## Reading a prompt before shipping it

- Read it as the peer: it has never seen this repo. Every noun that names a thing must be
  reachable from where the peer runs, or be described on the spot.
- Every sentence needs a verb the peer can perform, in the imperative or as a stated fact about
  what it may not do.
- Every rule carries its substance, not only its name.
- Guards protect contracts — the verdict block, the edit discipline, the stake, the review floor.
  They do not protect clarity, so clarity is what a human read is for.
- Do not paraphrase a prompt when reporting what it says. Quote it. A paraphrase that drops a
  clause reads as the prompt's own wording and is indistinguishable from an invention.
