# Architecture Decision Records

Recorded decisions:
- `0001-shared-parse-and-trace-format.md` — the run inspector and the task runner share one pure `shared/` module for parse/pairing/trace-format instead of duplicating it.
- `0002-peer-to-peer-prompts-deferred.md` — a peer cannot open a prompt to another peer, and the work is not planned; the docs say so instead of "designed but not reachable".

Write another here when a decision gets re-litigated or when the reason behind a
non-obvious choice is not recoverable from the code. Name it
`NNNN-short-title.md` (next: `0003-`), and keep it to: the decision, the
alternatives rejected, and what would have to change for it to be revisited.
