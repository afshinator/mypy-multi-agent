# Architecture Decision Records

Recorded decisions:
- `0001-shared-parse-and-trace-format.md` — the run inspector and the task runner share one pure `shared/` module for parse/pairing/trace-format instead of duplicating it.
- `0002-peer-to-peer-prompts-deferred.md` — a peer cannot open a prompt to another peer, and the work is not planned; the docs say so instead of "designed but not reachable".
- `0003-corpus-and-taxonomy-for-the-quality-loop.md` — the quality corpus is the opt-in list in run-date order, a card carries its task, and attestation re-work is a metric rather than a mistake class, because a binary class cannot express a continuous improvement.
- `0004-batch-driver-outside-the-runtime.md` — tickets become manifests before any process starts, and `mypi-batch` owns the lifecycle the runtime does not: it launches, polls for a finished `final.md`, closes the workspace, and halts the batch on the first failure.

Write another here when a decision gets re-litigated or when the reason behind a
non-obvious choice is not recoverable from the code. Name it
`NNNN-short-title.md` (next: `0005-`), and keep it to: the decision, the
alternatives rejected, and what would have to change for it to be revisited.
