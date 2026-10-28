# How the ten commits were chosen

- Pool: every commit whose subject starts with `fix` (case-insensitive), that touches
  `src/`, `shared/`, `web/` or `test/`, and that does not touch `scripts/antislop/`
  (the audit tooling itself, excluded to keep the sample from being self-referential).
  Pool size at selection time: **44**.
- Selection: a seeded draw (`mulberry32(20261027)` over the pool sorted by sha), ten commits.
  Reproducible: the same seed over the same pool returns the same ten.
- Extracted with `git show --format="" <sha>` into `fixtures/diffs/<sha>.diff`.
