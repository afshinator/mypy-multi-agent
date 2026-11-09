# 0004 — The batch driver lives outside the runtime

## Decision

**D1. Tickets become manifests before any process starts.** `mypi-batch prepare` reads a GitHub
ticket, verifies its claims with one agent and checks them with a second on a different model
family, and generates a `session.yaml` from a template. A run is then just a manifest in a task
directory. No new run type, no new extension command, no field in `SessionConfigSchema`, and
nothing in `Runtime` knows what a ticket is.

The Definition of Done has **one source: the issue body**. When the ticket carries one (a numbered
or checkbox list under a Definition of Done heading), that list is the manifest's DoD and triage
verifies it rather than authoring a replacement. When the ticket carries none, triage authors the
criteria, the verifier checks them, and prepare writes them back as a marker comment — the path
this decision originally described. An agent brief may list a change to a criterion, but a change
is a proposal: prepare refuses with its own reason code until the body carries it, so the
deliverable cannot be replaced without a visible edit to the ticket.

The reason is that a run cannot fetch its own ticket: the supervisor's toolset has no tracker
tool, by design. So the materialization has to happen before launch, and once it does, the
runtime needs no knowledge of where it came from.

**D2. The driver owns the lifecycle.** A successful run never exits pi and never closes its
workspace, and no component bounds its wall clock. So `mypi-batch run` creates the worktree,
starts the workspace, polls for a finished `final.md`, closes the workspace on every path, and
halts the batch on the first non-success. "Finished" is a filesystem property — `final.md`
parses, is unchanged across two reads, and the transient `.peer-*.json` files are gone — because
the runtime emits no completion signal.

**D3. Records are files, not state.** `batches/<id>/request.yaml` is authored once; everything
else is written by the driver and never rewritten by a later step. A finished run is frozen, so
the driver copies artifacts out of the worktree instead of writing into `run-details/`.

## Alternatives rejected

- **A batch run type in the runtime.** Needs the same driver anyway, and puts ticket semantics
  (markers, labels, kinds) into the schema every run shares.
- **`pi -p "/mypi-multi-agent <task>"` as the executor.** Structurally dead: the command handler
  returns without awaiting `sendUserMessage`, so print mode disposes the session and the
  extension aborts the run. Measured, not assumed.
- **Waiting on a completion signal.** There is none. Exit codes never appear, and a "decided"
  `final.md` can still be overwritten by an abort.
- **Writing the DoD into the issue body.** A body write has no lost-update protection against a
  concurrent editor, so the driver reads a body DoD and never writes one. Proposing a change
  through the brief keeps the body's ownership and the edit visible.
- **One config for a whole batch.** The finalize gate compares a run's verdicts to one manifest's
  DoD array.

## What would change this

- The runtime gaining a real completion signal and a self-closing workspace, which would remove
  D2's file polling and make the driver a launcher.
- A tracker tool in the supervisor's toolset, which would let a run fetch its own ticket and
  remove the manifest materialization step.
- Batch records becoming a store rather than files, which would move D3.
- A lost-update-safe body write in the tracker, which would let prepare apply an accepted
  criterion change itself instead of refusing until a human edits the body.
