# Seam refactor: post-change equivalence evidence (#102)

Date: 2026-10-23. Refactors: #99 (transport seam, `PeerLink`), #100 (peer endpoint
descriptor), #101 (launch seam, `PeerLauncher`). Claim under test: the seams
changed where a peer runs and how a message reaches it, and nothing observable
about a run.

Two live runs on the refactored tree, in order:

| Run                     | Before which seam       | Outcome                                           | Cost  |
| ----------------------- | ----------------------- | ------------------------------------------------- | ----- |
| `08-seam-99-smoke`      | #100, #101              | success, 4/4 criteria, 29 spans                   | $0.10 |
| `09-seam-restart-check` | none (all three merged) | success, 5/5 criteria, 29 spans, one live restart | $0.23 |

This note records the checks from #102 against `09-seam-restart-check`. Every
value below was read from the artifacts or re-run, not copied from a peer report.

## 1. Artifacts present

`final.md`, `findings.md`, `plan.md`, `run-state.json`, `scorecard.json`,
`spans.jsonl`, `tool-calls.jsonl`, `conversation.jsonl` — all present in
`mypi-tasks/09-seam-restart-check/run-details/`.

## 2. Span topology

29 spans, **one** `trace_id`, one root (`run`, `run-level`), no orphan parents,
no open spans. Edges observed:

| Edge                              | Count |
| --------------------------------- | ----- |
| `run` → `dispatch`                | 2     |
| `run` → `finalize`                | 1     |
| `dispatch` → `peer.turn`          | 2     |
| `dispatch` → `final_report`       | 2     |
| `peer.turn` → `tool`              | 17    |
| `finalize` → `validation.command` | 4     |

Same shape as run `08` (29 spans, one trace, one root), which was taken before
the launch and endpoint seams landed.

## 3. Tool-call log

17 rows, every row parses and carries `agentId`, `toolName`, `args`,
`durationMs`. Zero malformed rows.

## 4. `final.md` frontmatter

Keys: `status`, `exit_code`, `total_cost_usd`, `total_tokens`,
`supervisor_cost_usd`, `supervisor_tokens`, `agents[]` — the run-08 key set plus
`supervisor_tokens`, which was already emitted before the seams.

## 5. Verdict block

Five criteria attested, one `pass` each, in DoD order, every criterion string
byte-identical to `session.yaml` (checked by comparison, not by eye).

## 6. Gates

- `bun run test`: 793 passed | 2 skipped (795), 95 files passed | 2 skipped (97).
- `bun run typecheck`: clean.
- `bun run lint`: exit 0, 86 warnings — the same count measured on a clean
  worktree at `main` before the seams, so no new diagnostics.
- No existing assertion was edited. The only change to an existing test is
  `test/unit/abort.test.ts` renaming the injected fixture key `paneManager` to
  `launcher`; assertions are untouched.

## 7. Diff scope, `f41a195..HEAD` (the merge base before #99)

```
 src/bus/peer-link.ts        +154   src/peer/peer-launcher.ts   +49
 src/peer/peer-main.ts        +27/-   src/peer/peer-config.ts    +7
 src/runtime/runtime.ts       +82/-   src/control/abort.ts       +4/-
 src/control/control-plane.ts  +2/-   src/pi/extension.ts        +12/-
 test/unit/peer-link.test.ts +137   test/unit/abort.test.ts      +8/-
```

Untouched: `src/runtime/heartbeat-monitor.ts`, `src/bus/socket-server.ts`,
`src/herdr/`, `src/logging/` (verified by `git diff --stat` over those paths:
zero lines). Peer argv is unchanged: `peerCommand` is still the only producer of
the command line, and the only diffs near it rename the list that carries it.
`emit` keeps its shape — same silent drop for an absent recipient, now via
`PeerLink.send`/`sendAll`.

## 8. The restart, which unit tests cannot cover

`conversation.jsonl` for run 09:
- t=…786884 `restart-agent`, `agentId: implementer`, `costUsd: 0.048781744`
- t=…787085 a **second** `AGENT_REGISTER` from `implementer` (201 ms later)

`final.md` still reports `implementer` at `cost_usd: 0.05`, so spend survived the
restart (RT-4 holds) and the peer was respawned through
`HerdrPeerLauncher.respawn` rather than a fresh pane.

## 9. What this does not prove

- **Structural equivalence, not identical output.** Model output differs run to
  run; what is pinned is the artifact set, the span shape, the key set, the
  verdict form and the diff boundary.
- **The 86-warning baseline is a moving reference.** It was measured at
  `main` before the seams; a future change that adds a warning anywhere moves it.
- **A count discrepancy between environments, resolved after this note was
  first written.** Running the suite in a plain shell gives 95 passed / 2 skipped
  files and 793 / 2 tests; the peers inside the run reported 96 / 1 and 794 / 1.
  Cause, verified: `herdr` sets `HERDR_ENV=1` in every pane (confirmed by hand),
  peers are started with `herdr pane run` and inherit it, and pi's bash tool
  spawns children with a full copy of its own environment (`getShellEnv()` spreads
  `process.env`; the tool then deletes only `PI_*` keys). The e2e suite's gate was
  `HERDR_ENV === "1"`, so a peer running `bun run test` performed a real
  end-to-end run of its own. Historical corroboration: the peers in runs 06, 07
  and 09 all reported exactly one skipped file, which is the in-pane view.
  Fixed in the same change as this note by gating on an explicit `E2E_LIVE=1`;
  after the fix, `bun run test` reports 96 passed / 2 skipped both with and
  without `HERDR_ENV=1`, and `test/e2e/e2e.test.ts` is skipped in both.
  An earlier note on #99 claimed the run-08 reviewer "got the file counts wrong".
  That claim was wrong and is retracted: the counts differ by environment, and
  neither set is evidence against the peer.
