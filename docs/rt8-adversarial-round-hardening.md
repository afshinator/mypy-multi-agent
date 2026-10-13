# RT-8 — Hardening `spec-plan-adversarial`: evidence, falsifiers, and attestation integrity

**Status:** recommendation, not implemented
**Targets:** `templates/spec-plan-adversarial.yaml` (primary), `templates/code-fix.yaml`, `docs/agent-config-guide.md`, `test/integration/guardrails.test.ts`
**Origin:** an independent authoring exercise — a combined diverge-and-defend run written for
`mcp-server-go-quality/.mypi/task-t3-t4-hardening/session.yaml` — diffed against this repo's template.
Everything below is a delta the template does not currently carry.

---

## Why bother

The template already gets the *topology* right: one writer per document, a frozen contract, a
different-model opposition round per load-bearing decision, a verifier after the set exists, a
reviewer last. Those are the hard parts and they are correct.

What it does not yet do is make the opposition round **cost** something, or make the final
attestation **mean** something. As written, a run can produce a perfectly formatted
diverge-and-defend section — `ACCEPT-and-revise`, `REBUT-with-evidence`, `REJECT-with-reason`, one
per decision — while every position in it is an unsupported assertion, and still reach
`exit_code: 0`. The format is checkable. The substance is not.

Two failure modes fall out of that:

- **Shallow rounds that read deep.** The opponent's cheapest path is agreement. "No objection,
  the proposal is sound" satisfies the protocol, costs one turn, and requires no work. Enumerating
  failure modes is the expensive path, so the protocol rewards not doing it.
- **Attestation that counts instead of verifies.** See D2 below: the gate checks verdict *count*
  and the `pass` flag. It does not check that a verdict means what the criterion says.

---

## D. Two defects to fix before adding anything

### D1 — `consistency_verifier` cannot execute a single command

The template declares:

```yaml
  - id: "consistency_verifier"
    permissions:
      read: true
      edit: false
      shell: true
```

and sets no `shell_allowlist`. In `src/pi/tool-permissions.ts:19-23`:

```ts
export function canShell(p: Permissions, command: string): boolean {
  if (!p.shell) return false;
  if (p.edit) return true;
  return (p.shellAllowlist ?? []).includes(command);
}
```

With `shell: true, edit: false` and no allowlist, the final line evaluates `[].includes(command)` —
always false. **The peer advertised as an independent consistency verifier has no command access
at all.** It is a document reader wearing a verifier's title.

This is a bug, not a preference. Two acceptable fixes:

- give it an exact-match allowlist of the checks it actually needs (see R9 for the caveat), or
- set `shell: false` and rename it so its role is honest — a read-only document reviewer.

A run that shipped with this in place has an unverifiable claim in its `final.md`:
"An independent consistency verifier confirms the complete set."

### D2 — the finalize gate counts verdicts, not meaning

`src/supervisor/finalization.ts:52-58`:

```ts
export function criteriaSatisfied(
  verdicts: readonly CriterionVerdict[] | undefined,
  criteria: readonly string[],
): boolean {
  if (verdicts === undefined || verdicts.length !== criteria.length) return false;
  return verdicts.every((v) => v.result === "pass");
}
```

It compares **counts**, never the criterion strings, and never checks who sent the block. The
guide documents both facts. This is safe against a *missing* verdict and unsafe against a
*wrong* or *unverified* one: a verdict that restates the criterion loosely, or covers a different
concern, passes.

A central fix would mean changing the contract. Until then the mitigation belongs in the
supervisor prompt and the DoD, which is what R7–R10 do.

---

## R. Recommended template changes

### R1 — Evidence classes on every claim, from every participant

Add to the supervisor prompt and to each peer prompt. Every claim must be labelled:

| Class | Means |
|---|---|
| `exec-here` | a command run in this workspace, raw output pasted. Also a test observed to pass or fail. |
| `citation` | a `path:line` quote from this repo, the standard library, or a dependency in the module cache. Quote it; do not paraphrase. |
| `reasoned` | a logical argument naming its assumptions. Allowed **only** where the other two are impossible, and it must say why. |

Without this, "evidence" means prose and the requirement is decorative.

### R2 — Falsifier pre-registration

The decision owner must name **the observation that would change its mind, and the exact command
that produces it**, before the opponent is asked to review. The opponent must then **actually run
it** and report what it observed, whether or not that supports the direction.

This is the single highest-leverage change here. It converts an open-ended "review this" into a
bounded experiment with a pre-registered prediction, which is what makes the round falsifiable
rather than rhetorical.

Insertion — decision statement format:

```
FALSIFIER: <the observation that would change your mind> | <the exact command that produces it>
```

Insertion — opponent response format:

```
FALSIFIER RESULT: <the implementer's named falsifier> | <command run> -> <raw output>
```

### R3 — Agreement must be earned: two enumerated challenges minimum

The opponent must surface **at least two** specific, evidence-labelled candidate failure modes and
classify each blocking or non-blocking **before** it may conclude `no-objection`. Enumerating
failure modes is the work; agreement becomes the conclusion rather than the default.

Counter-weight, equally important: **manufacturing objections is also banned.** A candidate that
cannot be evidenced to any class is withdrawn, not raised, and labelling something `reasoned` when
it could have been run is itself a shallow-round signal. Without this, R3 produces noise.

### R4 — Symmetric withdrawal rule

The template already has "an unsupported claim is withdrawn, not accepted" for the *authors*.
Extend it explicitly to the opponent so it cannot block on an unfalsifiable claim: "it might race",
"this could be fragile", "consider whether…" are not objections. An objection names the failure,
the smallest fix, and the exact command that would confirm the fix.

### R5 — Reproduction duty

For any `exec-here` claim a decision rests on, the opponent must re-run it itself and report the
result. At minimum it must reproduce **the single most load-bearing execution claim in the run**
and say which one that was. A pasted output that nobody re-ran proves nothing, and the opponent
should say so if it could not reproduce one.

### R6 — Demonstrate the canary

Any run that adds a regression test must show it **failing with the fix disabled, then passing
with it restored**, with raw output for both. A test that has only ever been observed to pass is
not evidence that it guards anything. This is cheap, mechanical, and the best available proxy for
whether the surrounding round was real.

### R7 — Build a criterion → check attestation table before attesting

Before asking for the final attestation, the supervisor maps **every** DoD criterion to the single
command or artifact check that establishes it:

- criteria asserting an *absence* → a `grep` that must return nothing
- criteria asserting *behaviour* → a test invocation
- criteria asserting something is *unmodified* → a `git diff` on those files
- *process* criteria → a named section of `plan.md` to read

A criterion that cannot be reduced to a command or a concrete artifact check will be attested by
vibes. Saying so in the prompt is the point.

### R8 — The attester runs the checks itself

The attester executes each command in the table and pastes **its own** raw output as that
verdict's evidence — never the author's output, never a paraphrase of the criterion. **A verdict
the attester did not personally run is a fail.** This is the rule that makes D2 survivable.

### R9 — Independent locator audit by a second read-only peer

Give the verifier/reviewer a second job: for every evidence locator in the verdict block, confirm
it resolves — the file exists, the line exists, the quoted text is really there, and where a
command output is cited, re-run it and compare. Report each as RESOLVES / DOES NOT RESOLVE.

This is the only control that catches a fabricated-but-well-formatted pass, and it works because
it is a **different model** re-running the same commands. Note the `canShell` caveat: matching is
`Array.includes` on the exact string, so an allowlist needs full command lines and cannot chain
with `&&`, pipes, or globs.

### R10 — Sender and count check, performed by the supervisor

Require the verdict block to begin with `ATTESTER: <agent-id>`. Before finalizing, the supervisor
confirms the sender is the designated attester, that there is exactly one verdict per criterion in
config order, and that the criterion strings match one-to-one with no duplicates or extras. Also:
if a non-designated peer emits a block, ignore it and say so.

### R11 — Mechanical round-rejection conditions

The supervisor must **reject and re-run** a round, naming which condition failed, when any of these
holds:

- every evidence item on a side is class `reasoned`
- the falsifier was named but not executed
- the opponent returned fewer than two enumerated challenges
- a disposition (`ACCEPT`/`REBUT`/`REJECT`) arrived without evidence

Stating the conditions is not enough; obliging the supervisor to name the failed one is what makes
it act.

### R12 — Contradictory evidence protocol

When the author's evidence and the opponent's evidence contradict each other, the supervisor must
**not** pick a side or average them. Send the conflict back for one extra round on that decision
alone, requiring each side to reproduce the other's claim. If it remains irreconcilable, record
both positions with their evidence and state which risk was accepted. A decision with no stated
basis is the exact failure this template exists to prevent.

### R13 — Allowlists for every read-only peer expected to verify

Any peer with `read: true, edit: false, shell: true` needs a non-empty `shell_allowlist`, or it
can do nothing (D1). Keep them to non-mutating reads: `git status`, `git diff`, `git diff --stat`,
`git log --oneline -5`, plus the specific test and query commands that peer needs.

---

## Open question — where does the process criterion belong?

`docs/agent-config-guide.md` says process requirements (branch, `plan.md`, `findings.md`,
`validation.commands`) are the run contract, "checked at finalize separately from the DoD, and
never written into the DoD". `templates/spec-plan-adversarial.yaml` nevertheless puts the
diverge-and-defend requirement in `definition_of_done`:

> "Every load-bearing decision has a recorded different-model opposition and an author disposition
> (accept/rebut/reject) with the supervisor's call."

Both cannot be right. The template's approach is the one that works — the run contract only checks
that `plan.md` exists (`src/validation/run-contract.ts`), so a process criterion with a **named
artifact** is enforceable in the DoD and unenforceable outside it.

Recommendation: keep it in the DoD and amend the guide's wording to carve out process criteria
that name a concrete artifact to inspect. Flagging rather than silently diverging, because the
guide is presented as checked against the code.

---

## What we deliberately did **not** adopt

Recorded so these are not re-proposed:

- **A second verdict block from a second peer.** `criteriaSatisfied` compares counts against the
  DoD length; two blocks risk breaking that check for unclear benefit. R9 gets a second pair of
  eyes on the same block without touching the gate.
- **Machine-checking the criterion strings.** Would require a contract change to
  `criteriaSatisfied`. R10 approximates it in the supervisor prompt; the real fix is a contract
  item, not a template item.
- **A budget floor to prevent rushed rounds.** Indirect, unenforceable, and the run's own
  accounting does not support it.
- **More than three peers for a bounded task.** Two focused peers plus a supervisor beat a wide
  roster; see MT-7.

---

## Test plan

1. **Guard D1 mechanically.** Add to `test/integration/guardrails.test.ts`, alongside the existing
   template parse check:

   > every template agent with `permissions.shell === true && permissions.edit === false` declares
   > a non-empty `shell_allowlist`

   This is the same shape as the existing "finds at least one in-repo relative link to check"
   self-check: it catches the class of bug that produced D1 and cannot be satisfied by commentary.
   `spec-plan-adversarial.yaml` must be fixed in the same commit or the test fails — which is the
   point.

2. **Guard the R2–R6 vocabulary.** Assert that a template whose DoD mentions diverge-and-defend
   also mentions a falsifier and an evidence class, so the prompt and the DoD cannot drift apart.

3. **Live run, bounded.** Run the hardened template on a small task and inspect `plan.md`'s
   decision log directly. Diagnostics:
   - mostly `reasoned` evidence cells → R1 is decorative, tighten R11
   - opponent challenges are one-liners → R3 is being satisfied by padding, not work
   - no falsifier result recorded → R2/R11 not wired

4. **Negative test.** Confirm the supervisor actually rejects an all-`reasoned` round rather than
   recording it. Without this, R11 is a paragraph.

---

## Provenance

Authored from `mcp-server-go-quality/.mypi/task-t3-t4-hardening/session.yaml` (3 peers:
implementer, adversary, ponytail), which applies R1–R13 to a two-decision run. That config is a
worked example of the full prompt text for each rule and can be lifted directly.
