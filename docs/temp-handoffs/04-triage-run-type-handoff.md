# Handoff — automating the fixes by way of a run type that can triage

Repo: `afshinator/mypy-multi-agent`, HEAD `6e39a2e`, 2026-10-31, tree clean, `bun run check` green.
Next session's focus: **a new kind of run whose work is triage** — take an issue, verify it, decide
whether its need is real and reachable, write or refuse a Definition of Done, and then hand off to a
fix run or to inline work. This document says what you inherit, what is missing, and where the code
would go. It references artifacts instead of restating them.

## What you inherit (verified today)

- **Eight new tickets, all written from a cold-start standpoint**: #163–#170 (see the table below),
  each with evidence, reproduce commands, proposed fix, DoD and an out-of-scope fence.
- **Five are `ready-for-agent`**: #163, #164, #165, #168, #169.
- **Three carry `needs-info` because an open decision blocks them**: #166, #167, #170. Do not hand
  those to an implementer before the decision is written in the issue — that is exactly the failure
  the triage brief warns about ("the agent picks one silently").
- **The old blocker set is gone.** #125, #138, #139 are closed. #138 shipped `6e39a2e`
  (`src/pi/tool-result-hint.ts`, wired into peers and the supervisor); #139 and #125 were doc/data.
- **Gate and rules**: `main` is protected; land a branch with `just land` (push → PR → wait for the
  `check` workflow → rebase merge). `bun run check` must exit 0. A refusal that names `just land` is
  the gate working, not a bug.
- **Frozen artifacts**: a finished run is frozen. Never edit `mypi-tasks/*/run-details/` or a
  completed `session.yaml`. Lessons go into `templates/` and `docs/agent-config-guide.md`.

| Ticket                                                      | Report code | Strength        | Label state              |
| ----------------------------------------------------------- | ----------- | --------------- | ------------------------ |
| #163 closing record into the Finalize gate                  | C1          | Strong          | ready-for-agent          |
| #164 peer extension assembly + `lockAcquireTimeoutMs` drift | C2          | Strong          | ready-for-agent, **bug** |
| #165 one retry policy in `peer-harness`                     | C3          | Strong          | ready-for-agent, **bug** |
| #166 turn/liveness state module                             | C4          | Worth exploring | needs-info               |
| #167 ledger statistics authority                            | C5          | Worth exploring | needs-info               |
| #168 inject `PeerLink`                                      | C6          | Worth exploring | ready-for-agent          |
| #169 antislop verifier seam                                 | C7          | Worth exploring | ready-for-agent          |
| #170 Scorecard DoD from the gate's verdicts                 | C8          | Speculative     | needs-info               |

The durable record of the review that produced them is the issues themselves; the HTML report was a
throwaway in `$TMPDIR`.

## The job, stated as the gap

The triage machinery exists as **text only**: `docs/triage-prompt.md` (issue → DoD, conditional) and
`docs/triage-verifier.md` (row-by-row claim check by a fresh agent on another model family). Nine
triage runs used the prompt; one produced a DoD. The verifier was calibrated on two tables with
planted defects and refused every one. Nothing runs either prompt: a human copies the fenced block
into a subagent call.

Read `docs/triage-loop-brief.md` before anything else. It records D1–D9 (settled), R1–R6 (not
proven) and the **unsettled frontier of eight questions**. Two of them block the rest:
1. **Is the loop's unit one issue or a batch?**
2. **Where does the runner live** — a shell loop, a `justfile` recipe, a supervisor prompt, or a new
   peer/preset in a run?

Your session should settle where the runner lives, then either build it or record explicitly that it
will not be built. Everything else (verifier as gate or advice, who takes the `run`/`inline` branch,
per-issue bound, whether the loop may touch the tracker) follows from that choice.

Update the brief as decisions land: A3 and A4 are done (#139 implemented, #138 and #125 settled), A5
(`ready-for-agent` means something) is now the live enforcement question, A1 and A2 are untouched.

## Where the code would go if "a run type" is the answer

Read these before proposing a shape:
- `templates/*.yaml` — a run is a manifest: `version`, `session`, `ask.definition_of_done`, `agents[]`
  with per-agent model, permissions, budget and `system_prompt`, plus `validation`. `code-fix.yaml` is
  the closest existing shape to a fix run; `post-mortem.yaml` is the closest to a read-only
  investigation; `spec-plan-adversarial.yaml` shows an attester-driven plan critique.
- `src/contracts/session-schema.ts` — the manifest is a strict Zod contract; an unknown key fails the
  launch. A new run type means schema, not only a template.
- `src/pi/extension.ts` — where `/mypi-multi-agent` starts a run and where the supervisor's tools are
  registered; a "triage" entry point would land here or beside it.
- `src/runtime/finalize-gate.ts` — the five terms a run must satisfy. A triage run's DoD is about a
  report, not about code, so the validation and run-contract terms need an answer.
- `src/peer/peer-main.ts` — the peers' extension list (six factories, inline, no exports; that is
  #164). If a triage peer needs different tools, this is the assembly point.
- `docs/agent-config-guide.md` §5 (session fields) and §10 (how to write prompts for this system).

Three candidate homes, each with a different cost — none decided:
- **A `justfile` recipe** driving two subagent calls (triage, then verifier). Cheapest; no runtime
  change; the report and the verdict live outside a run's artifacts.
- **A supervisor prompt** that runs the phase as its first turns inside an ordinary run. Reuses the
  gate and the artifacts; costs a run for work that may end in "no change needed".
- **A new preset/template** whose ask is an issue number, with the verifier as the attester. Most
  faithful to D5/D6 ("one mismatch means the DoD is not accepted"), and the only option where the
  gate enforces the verdict. It is also the only one that needs schema work.

## Constraints that will bite

- `main` protected; `just land` only. Never push to `main` directly.
- A finished run is frozen — do not "fix" a past run's config; put the lesson in `templates/`.
- `bun run check` runs lint, oxlint, both typechecks and both test suites; it must be green. Note
  `tsconfig.json` covers `src`, `test`, `shared`, `scripts/antislop` — **not** other `scripts/`.
- macOS userland: no `timeout`, no GNU coreutils, `python3` has no `yaml` (use `bun -e`).
- `rg -r` means _replace_, not recursive; never pass it meaning "search".
- Issue tracker etiquette: comments posted during triage start with the AI-generated disclaimer
  (`.agents/skills/triage/SKILL.md`).

## Assumptions in this handoff to re-check

- **Line numbers** in #163–#170 were verified at `6e39a2e`. If HEAD has moved, re-run each ticket's
  own reproduce block before trusting it.
- **#166's first decision** ("is `HeartbeatMonitor` absorbed or kept?") is unverified beyond the
  class itself; the exploration flagged that the connection layer may also use it. Check before
  deciding.
- **#167 and #170 are product decisions** (absent-vs-zero; record-vs-re-derive). They change published
  numbers and what a card's `dod` means. Neither is a code question.
- **Cost figures** in the brief (60–95k tokens per triage, ~20k for a verifier) predate this session;
  a two-agent exploration here cost ~131k tokens for a full architecture pass, so the order of
  magnitude holds but the numbers are not current.

## Suggested skills for the next session

- `grilling` — walk the eight unsettled questions to a decision; that is the session's real work.
- `to-spec` — turn the settled answers into a spec for the runner.
- `to-tickets` — break the spec into blocked, tracer-bullet tickets.
- `triage` — the role machine and the disclaimer rule, if you touch tracker state.
- `implement` / `tdd` — when a ticket is ready to build.
- `domain-modeling` — the new run type will need a glossary term (it is not a _run_, a _peer_ or a
  _post-mortem_ as `GLOSSARY.md` defines them) and probably an ADR for "the runner lives here".
- `writing-for-agents` — you will be writing or editing the triage prompt and the guide.

## Pointers

- Tickets: #163, #164, #165, #166, #167, #168, #169, #170.
- Triage text: `docs/triage-prompt.md`, `docs/triage-verifier.md`, `docs/triage-loop-brief.md`.
- Evidence: `docs/evidence/triage-prompt-2026-10-29.md`,
  `docs/evidence/triage-verifier-calibration-2026-10-30.md`.
- Domain: `GLOSSARY.md`; decisions: `docs/adr/README.md` (next number is `0004-`).
- Architecture of the current system: `docs/temp-handoffs/01-architecture-handoff.md`.
- Run artifacts (frozen): `mypi-tasks/*/run-details/`.
