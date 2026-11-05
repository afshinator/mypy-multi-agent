# 0005 — `inline` outranks the policy, and stays ungated

> **Superseded by #328.** The `inline` answer no longer exists: every accepted ticket runs via a
> kind template, and its DoD passes through the verifier. D1 below is historical; the DoD gate
> remains the mitigation.

## Decision

**D1. A triage answer of `inline` is always accepted, whatever `prepare.kinds` lists.**
`src/batch/prepare.ts:240` refuses a kind the policy does not name but exempts `inline`, and the
triage prompt tells the model to use it "when the change is small enough that a run is not worth
it" (`src/batch/prepare.ts:162`). So a batch configured for `code-fix` alone can still publish an
`inline` DoD and spend no run.

The reason is what a rejection would cost. `inline` is a _smaller_ answer than a run, and the
policy cannot see the ticket: it names kinds the operator is willing to run, not the kinds a
ticket deserves. Refusing `inline` on a ticket that needs no run would refuse the cheapest correct
outcome a triage can produce, and the batch has no second pass to recover from it — `prepare`
records one verdict per ticket and moves on.

**D2. That costs a triage spend, and #291 measured it.** The same ticket, models and prompt came
back `code-fix` in one run and `inline` in another (finance-hub live3 vs live4), and the two runs
published different Definitions of Done. Four live triages in total have all answered `inline`
(`docs/batch-guide.md:165-167`), so the `code-fix` path has never been exercised against a real
ticket.

**D3. The DoD gate is the mitigation, not the kind.** #291's preferred fix — the verifier
checking each DoD criterion's soundness, not only the claim table — is implemented
(`src/batch/report.ts:341-355`). A wrong kind publishes a DoD a verifier has now checked; before
#291, nothing did.

## Alternatives rejected

- **Gate `inline` behind `prepare.kinds` (#291's O3).** It removes the kind flip by removing the
  answer, and a policy that lists only `code-fix` would then refuse every ticket a live triage
  has actually produced. Rejected until a real ticket needs a run and cannot get one.
- **Lower the triage temperature or pin a seed (#291's O2).** Shrinks variance, does not remove
  it — providers do not all honour a seed — and leaves the published DoD unchecked.
- **A second triage pass to break a tie.** Doubles the spend per ticket to resolve a disagreement
  whose harm the DoD gate already bounds.

## What would change this

- A ticket that genuinely needs a `code-fix` run but comes back `inline`, or a batch where the
  kind flip costs a spend worth avoiding: that is the trigger for O3, and it should arrive with
  the ticket number that shows it.
- A tracker field that carries the kind across a re-prepare, which would let a batch pin the kind
  it already paid for instead of re-deciding.
