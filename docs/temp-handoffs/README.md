# Temporary handoffs

Working documents written at the end of one session so the next one can pick up. They are
scratch, not doctrine: read the linked issues and commits for what is still true.

Files are numbered in creation order. The number is the order the document was first written,
not the order it was last edited.

| File                                     | Subject                                                                | Status     |
| ---------------------------------------- | ---------------------------------------------------------------------- | ---------- |
| `01-architecture-handoff.md`             | System map: state layout, invariants, where state lives, reading order | current    |
| `02-telemetry-correlation-handoff.md`    | Trace/correlation decisions D1–D7 and the verification checklist       | historical |
| `03-verification-handoff.md`             | Independent verification checklist for the trace/correlation claims    | historical |
| `04-triage-run-type-handoff.md`          | Next session: automate triage as a run type; inherits issues #163–#170 | live       |
| `05-batch-ticket-loop-review-handoff.md` | Does the triage exploration support a batch ticket loop? F1–F13, R1–R4 | live       |

## Moved here on 2026-10-31

The first three lived at `docs/<name>.md` and moved into this directory on 2026-10-31, which is
why their order comes from the commit that first added each file, not from the filesystem: the
move rewrote every mtime and birth time to the same second. Two frozen run
manifests still cite the old paths and are left as written, because a finished run's
`session.yaml` is never edited: `mypi-tasks/s6-tracing/session.yaml` and
`mypi-tasks/config-taskdirs/session.yaml`. Nothing else refers to the old locations.
