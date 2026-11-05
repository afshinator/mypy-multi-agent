# Attester read-only verdict — a command criterion is a pass by reading (#314, #318)

Issue #314, landed as #318. The batch attester has `shell: false` by design — it attests by
reading the branch, not by running anything — yet its prompt carried two rules with no
tie-break and a blanket refusal that would fail the most common command criterion in the
corpus.

## The failure it fixes

A batch DoD is full of command-shaped criteria: "`bun run test` exits 0", "`bun run typecheck`
exits 0", "`fallow health` reports 77 B or higher". The attester cannot run any of them. The
prompt written in e35d426 said, in one paragraph:
- "a criterion you cannot verify from the tree is a mismatch, not a pass";
- "verify the command, the fixture it reads and the shape of the output it asserts";
- "A command-shaped criterion with no fixture to run against is a mismatch."

The first and last collide: `bun run check` exits 0 has no single fixture, so the blanket rule
turns a criterion with a perfectly good proof into a failure. And nothing in the prompt said
what verdict a read-only-checked command criterion actually gets. `result` was defined as
"`pass` or `fail`" with no pass condition for that shape.

## What the prompt says now

The precondition moved into R1 (the situation), ownership stays in R2, and the verdict rule
landed in R4:
- R1 — "You have no shell, so a proof you accept is one you read: the command, the input it
  names, and the file:line that makes the criterion true."
- R2 — "You own the verdict and no file: you cannot edit, and a criterion the tree does not
  support is a mismatch, not a pass."
- R4 — "A criterion proved by a command you verified by reading — the command, its input and
  the tree it names — is a `pass`; a criterion you cannot tie to the tree at all is a `fail`."

The three removed sentences — "cannot verify from the tree", "say in the evidence that the
check is read-only", and "no fixture to run against is a mismatch" — are gone. The
`templates/batch-code-fix.yaml` attester's prompt now has one verdict rule, and the guard in
`test/integration/guardrails.test.ts` fails if the R1 sentence, the R4 rule, or the absence of
the no-fixture rule changes.

## What the attester does not decide

The exit code itself is not the attester's to verify. The finalize gate runs
`validation.commands` (`bun run check`) mechanically, and prepare already re-ran each
criterion's proof before the ticket reached `ready-for-agent`. The attester's verdict is the
tree evidence: that the command exists, that its inputs are real files, and that the branch
changed what the criterion names. Two different subjects stay two different subjects.

## Limit

No batch has attested a command-bearing DoD since this change, so the effect is unmeasured:
this file records what changed and why, not that it worked. The guard pins the sentences, not
the judgement.
