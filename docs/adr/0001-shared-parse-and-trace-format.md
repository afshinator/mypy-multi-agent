# Shared parse-and-format module (`shared/`)

The run inspector web app and the task runner must agree on how run artifacts are parsed and paired, so the pure readers — JSONL parsing, turn pairing (`turnKey`), W3C `traceparent` format/parse, and the `SpanRecord`/`SpanName`/`Kind`/`SpanStatus` types — live in one top-level `shared/` module imported by both, rather than being duplicated in `web/`.

## Considered Options

- **Duplicate the logic in `web/`.** Rejected: two implementations of `parseJsonl`/`turnKey`/traceparent would drift and misparse spans or mispair turns.
- **Import directly from `src/`.** Rejected: couples the browser build to the runner's tree and its `node:*` imports.
- **A bun workspace / published package.** Rejected as overkill: both `src/` (bun) and `web/` (Vite) compile TypeScript directly, so a plain directory plus relative imports needs no build step.

## Consequences

`shared/` must stay free of `node:*`/bun imports or the browser build breaks — that is the one rule that keeps it safe. The runner's `readJsonl` becomes `parseJsonl` plus a thin `readFile` wrapper; the tracer (`FieldsTracer`, `randomHex`) stays in `src/` because the app only reads spans, never mints them.
