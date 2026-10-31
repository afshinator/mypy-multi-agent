# Temporary handoffs

Working documents written at the end of one session so the next one can pick up. They are
scratch, not doctrine: read the linked issues and commits for what is still true.

| File                               | Subject                                                                | Status     |
| ---------------------------------- | ---------------------------------------------------------------------- | ---------- |
| `architecture-handoff.md`          | System map: state layout, invariants, where state lives, reading order | current    |
| `telemetry-correlation-handoff.md` | Trace/correlation decisions D1–D7 and the verification checklist       | historical |
| `verification-handoff.md`          | Independent verification checklist for the trace/correlation claims    | historical |
| `triage-run-type-handoff.md`       | Next session: automate triage as a run type; inherits issues #163–#170 | live       |

## Moved here on 2026-10-31

The first three lived at `docs/<name>.md` and moved into this directory. Two frozen run
manifests still cite the old paths and are left as written, because a finished run's
`session.yaml` is never edited: `mypi-tasks/s6-tracing/session.yaml` and
`mypi-tasks/config-taskdirs/session.yaml`. Nothing else refers to the old locations.
