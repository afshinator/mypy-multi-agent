# Run Inspector (web viewer)

A read-only browser UI for **finished** `mypy-multi-agent` task runs. It renders
one run's persisted artifacts — DoD verdicts, timeline, tool calls, trace,
roster, health scorecard, trace analysis, plan/findings, and a service/node
graph — so a human can understand what a run did and why without re-running
anything or reading JSONL by hand.

## What it consumes

One task directory (e.g. `mypi-tasks/06-quality-ledger/`) plus its `run-details/`:

- `session.yaml` — the task's ask, DoD, and agent roster.
- `run-details/final.md` — decision record, summary, cost/token breakdown (frontmatter parsed).
- `run-details/findings.md` — raw per-peer reports.
- `run-details/plan.md` — the run plan.
- `run-details/scorecard.json` — the per-run health scorecard (derived metrics only).
- `run-details/spans.jsonl` — trace spans.
- `run-details/conversation.jsonl` — orchestration timeline events.
- `run-details/tool-calls.jsonl` — peer tool executions.
- `run-details/run-state.json` — run state and per-agent budgets/usage.

The viewer is **read-only**: it never writes to a task directory.

## Stack

- **Vite + TypeScript** static SPA — no backend, no persistence.
- **Local read-only data server** — a Vite middleware (`server-middleware.ts`)
  exposes `GET /api/fs/list` and `GET /api/fs/read` for browsers without the
  File System Access API. The projects root comes from `web/inspector.yaml`
  (`projectsDir`, `~` expanded); paths are traversal-checked and symlinks are
  realpath-verified.
- **Runtime deps exactly two**: `yaml` and `markdown-it`. Everything else is
  hand-rolled.
- **Layout**: views in `views/`, typed aggregates and parsers in `lib/`, SVG
  charts in `charts/`, styles in `styles/` (design tokens in
  `styles/tokens.css`). No inline styles.
- **Dual project source**: "Select folder" (File System Access API + IndexedDB)
  or "Load from server" (the middleware above).

## Run it

```bash
bun --cwd=web run dev        # dev server on 5173 — middleware active
bun --cwd=web run build      # static build — middleware NOT present
bun --cwd=web run test       # vitest
bun --cwd=web run typecheck
bun --cwd=web run lint       # biome
```

Note: the `/api/fs/*` server only exists under `vite dev` (5173). The static
bundle (`build`, then `vite preview`) has no middleware; use "Select folder"
there, or serve with `vite dev`.

## Current status

MVP complete. Views for summary, DoD, timeline, tool calls, trace, trace
analysis, roster, plan/findings, node graph, and the health scorecard; two
hand-rolled SVG charts (node graph, span waterfall); light/dark theming;
collapsible accordions with one-line summaries; hidden-project persistence; and
the read-only local server. It is a **viewer, not a runner**: it displays what a
run left behind and does not trigger or modify runs.

## Todo

Intentionally left as placeholders — this list is not yet fillable:

- [ ] Cross-run view — aggregate multiple finished runs into trends/improvements.
      Blocked on the quality ledger (#97) and the run-quality feedback loop
      (#10); the collector/trends/improvements modules exist but are unwired.
- [ ] TBD — remaining items deferred until the next spec.
