# Explorations

Documents that investigate a direction, measure a candidate, or record a comparison, and that
have **no related implementation in this repository**. Nothing here is doctrine, and nothing
here is run by code. If a file in this directory starts describing shipped behaviour, it
belongs next to the code it describes instead.

Inclusion test, applied per file: no module, script, template, test, config or workflow
implements what the document proposes or measures, and the code does not cite it. Documents
that fed a shipped feature stay where they are (`docs/run-inspection-ui-research.md`,
`docs/evidence/*`, `docs/antislop/*`, `docs/jev/*`).

## Index

| File                                                                   | What it explores                                                                                         | Status          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------- |
| `triage-automation/triage-loop-brief.md`                               | The loop that turns an issue into a Definition of Done: D1–D9 settled, R1–R6 unproven, 8 open questions  | live            |
| `triage-automation/triage-prompt.md`                                   | The prompt that investigates one issue and conditionally writes its DoD                                  | live, text only |
| `triage-automation/triage-verifier.md`                                 | The pass that re-runs a report's claim table on a different model family                                 | live, text only |
| `triage-automation/evidence/triage-prompt-2026-10-29.md`               | Two blind tests of the prompt                                                                            | measurement     |
| `triage-automation/evidence/triage-verifier-calibration-2026-10-30.md` | Two planted-defect tables against the verifier                                                           | measurement     |
| `pi-durable-cloud/pi-durable-fit.md`                                   | Fit of `pi-durable` and cloud peers against the local-pane model, with a sourced capability record       | research        |
| `pi-durable-cloud/cloud-agent-capabilities.md`                         | Capability matrix, local peer vs durable-object peer                                                     | research        |
| `landscape-and-positioning.md`                                         | Comparative review of this project against pi-native extensions and desktop front-ends                   | reference       |
| `tokeneconomizer-eval.md`                                              | Evaluation of the TokenEconomizer plugin; installed in the operator's global pi config, not in this repo | evaluation      |

The two triage handoffs stay in `docs/temp-handoffs/`
(`04-triage-run-type-handoff.md`, `05-batch-ticket-loop-review-handoff.md`) because a handoff is
written for the next session, not kept as an argument.

## Known cost of moving these

One frozen run manifest still cites the pre-move paths of `pi-durable-fit.md` and
`landscape-and-positioning.md`: `mypi-tasks/config-taskdirs/session.yaml`. A
finished run's `session.yaml` is never edited, so those citations are dead by design.
`docs/diagrams/*.d2` cited `pi-durable-fit.md` in comments; the comments were updated, and
comments do not render, so the images are unaffected.
