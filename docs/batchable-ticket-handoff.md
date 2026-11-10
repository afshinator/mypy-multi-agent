# Handoff: write batchable tickets

A prompt to paste to any agent, in any repository, that is about to create tickets for
`mypi-batch`. It is repo-agnostic on purpose: kinds, labels, cost and time bounds are read from
the target repo's own `mypi-batch.yaml` and its kind templates, so nothing here goes stale when a
repo retunes those.

The rules it encodes come from `docs/batch-guide.md` and the code that enforces them:
`src/batch/prepare.ts` (`freeGates`, `REFUSAL_REMEDY`), `src/batch/dod.ts`, `src/batch/report.ts`,
`src/supervisor/finalization.ts`, and the kind templates.

## The prompt

Copy everything inside the fence.

```text
You are writing tickets for this repository. They will be executed unattended by
`mypi-batch`: per ticket it clones the repo, runs a triage agent to verify your
claims, then runs a supervisor plus peers on an unmerged branch cut from `main`,
and an attester judges the result against the criteria in the ticket body. A
ticket that breaks a rule below is refused before anything is spent, or spends a
whole run and then fails. Follow the rules exactly.

## Read these first
- `mypi-batch.yaml` at the repo root: the offered kinds, the label strings, the
  run timeout. Whatever it says outranks your assumptions.
- The kind templates it names (`prepare.kind_templates`): the shape and the cost
  ceiling each run gets.
- `AGENTS.md`, `GLOSSARY.md`, and the ADRs in the area you are touching.

## Tracker
Use `gh` against this repository, following `docs/agents/issue-tracker.md`. One
issue per ticket. Apply the policy's ready label (default `ready-for-agent`). Do
not apply the skip label (default `not-batched`). Do not post an `## Agent Brief`
comment that proposes criterion changes: the body is the only list.

## The one mandatory section: the Definition of Done
The body MUST contain exactly one of these headings, spelled that way:

    ## Acceptance criteria
    ## Definition of Done

Under it, one criterion per line, numbered or `- [ ]`, each a single sentence.
That list is copied verbatim into the run's manifest, and a prepare refuses a body
that cannot supply it. After prepare, editing the body changes nothing, so get it
right the first time.

Every criterion must:
- describe a change that fails on today's `main` (a criterion that already passes
  is vacuous and is refused);
- name the surface it changes by symbol, type, config key, exported function or
  documented behaviour, not by line number and not by file path alone, because
  those go stale;
- be provable by a later session reading the changed tree at `file:line`. Assume
  the attester is read-only with no shell unless the kind's template says
  otherwise, so a criterion whose only proof is "run this and watch" is
  unattestable;
- be plain text: no markdown tables, no HTML, balanced backticks and bold. A
  leftover markdown construct refuses the ticket before anything runs.

Do NOT write criteria of these shapes. They are scope guards, true before the
work, and the mechanical validation command already enforces them:
- "tests still pass" / "the build succeeds" / "no behaviour change"
- "the diff touches only X" / "nothing else is changed"
- "the change is reviewed" / "the work is documented"

## What the body must also carry
- `## What to build`: the end-to-end behaviour from the user's side, one narrow
  vertical slice, one concern. Not a layer-by-layer list, not a file inventory.
- `## Blocked by`: each blocking ticket by `#number`, or "None". Declare an edge
  only where the code genuinely gates. Note to yourself, not in the ticket: each
  run branches from `main` and the batch never merges, so a chain where every
  ticket needs the previous ticket's code only works after someone lands the
  earlier branch. If a ticket cannot be built on unmerged `main`, say so in the
  body rather than hiding it in an edge.
- `## Out of scope`: the adjacent things the implementer must not touch.

## Truth rules for every factual sentence
The triage agent re-checks each claim of the ticket with a command, and a second
agent on a different model re-runs that command and compares its output.
- Cite real code. Check every file, symbol, count and line reference against the
  live tree before writing it. A citation that is off by a line is survivable; a
  claim the code contradicts ends the ticket as a refusal.
- Do not state counters (call counts, byte sizes, row counts) that can drift.
- Do not write a claim that needs an absolute path, a secret, an env-only
  variable, a live service, a network call, or data outside the repo's tracked
  files. Untracked directories are absent from the verifier's checkout.
- Prefer claims verifiable by `rg`, `read`, `git log`. Never a claim whose proof
  command writes, deletes, copies, moves, downloads or pipes into a shell.
- When a claim is uncertain, leave it out. The criteria are what matter.

## Size and shape
- One ticket is one run, bounded by `run.timeout_minutes` and by the kind
  template's `session.max_cost_usd`. Slice so that the implementers plus the
  attester finish inside those bounds.
- The change must be implementable so that the kind template's
  `validation.commands` passes, usually the repo's full check. A ticket that
  cannot keep that green is not batchable.
- It must fit one of the policy's `prepare.kinds`. Pick the smallest that fits: a
  two-implementer code kind for a real module change, a one-implementer kind for
  a change too small to split, a prose kind for docs or research.
- If a ticket needs a judgment call, a design decision, live service access, or
  manual verification, it is NOT agent-ready: apply the policy's human label
  (default `ready-for-human`) and say why in the body.
- Use the repository's own vocabulary. If a term you need is not in
  `GLOSSARY.md`, pin it down rather than inventing a second word for it.

## Self-check before you publish each ticket
    gh issue view <n> --json body,state,labels
    mypi-batch check <batch-id>     # cheap gates only: no clone, no model call
`check` must say `ok` for every ticket. If it refuses, read the reason code and fix
the ticket body. Never the driver, never the policy.

Final answer to me: the ticket numbers, the kind you expect each to be, the
blocked-by edges, and any ticket you deliberately made human-only.
```

## Why each rule exists

| Rule                                                            | Enforced by                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Body owns the DoD; triaged criteria are discarded in its favour | `definitionOfDone` (`src/batch/report.ts`), #469                                                 |
| Criteria must fold to plain text                                | `normalizeDoD` (`src/batch/dod.ts`) → `dod-rejected`                                             |
| No scope-guard criteria                                         | triage prompt step 5 (`docs/explorations/triage-automation/triage-prompt.md`)                    |
| Claims must reproduce under re-run                              | verifier prompt (`docs/explorations/triage-automation/triage-verifier.md`) → `verifier-mismatch` |
| Claim commands must be read-only and inside the clone           | `commandFaults` (#483); clone sandbox (#487) → `harness-error` / `unverifiable`                  |
| An unapplied brief delta refuses the ticket                     | `briefChanges` → `dod-unapplied` (#469)                                                          |
| Branch is cut from `main` and never merged                      | `run` step 2 (`src/batch/executor.ts`), `docs/batch-guide.md`                                    |
| Criteria are quoted verbatim by the attester                    | `criteriaMismatches` (`src/supervisor/finalization.ts`)                                          |
| `check` is the free gate                                        | `src/batch/prepare.ts` `check()` (#502)                                                          |
