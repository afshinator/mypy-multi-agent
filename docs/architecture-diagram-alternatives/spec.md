# Canonical content — the single source for all six diagrams

Every rendered diagram in this directory uses the node/edge/label set below.
There is exactly **one** content source: this file. Each generator has its own
DSL file (`.mmd`, `.d2`, `.dot`, `.svg`, `.excalidraw`, `.json`), and each DSL is
a **hand transcription** of this spec — there is no build step that generates one
from the other.

## Where the content came from

The semantics describe the **current implementation**, derived by reading:

- `src/runtime/runtime.ts` — run-details layout, bus socket location, finalize gate
- `src/pi/extension.ts` — supervisor tools, `/mypi-multi-agent`, `finalize`
- `src/pi/launch.ts` — the `mypi-run` launcher
- `src/bus/socket-server.ts`, `src/bus/message-validator.ts` — JSONL socket, F1/F2
- `src/peer/peer-config.ts` — permission-scoped peer tools
- `src/validation/run-contract.ts` — `plan.md` run contract
- `src/budget/usage-accounting.ts`, `src/budget/budget-enforcer.ts` — budget bounds
- `README.md`, `docs/agent-config-guide.md`

The previously committed `docs/architecture.json` was **not** used: it described
the pre-PORT, pre-I1/I2 architecture and has been deleted.

## Title / subtitle

- Title: `mypi-multi-agent — current architecture`
- Subtitle: `supervisor (pi) · herdr panes · JSONL unix-socket bus · .mypi/<task>/run-details/`

## Containers (3)

| id | Label |
|---|---|
| `control` | Control — supervisor |
| `bus` | Bus · peers |
| `artifacts` | Artifacts — .mypi/&lt;task&gt;/run-details/ |

## Nodes (8)

| id | Container | Label | Sub-label |
|---|---|---|---|
| `launcher` | control | mypi-run [dir] | launcher: herdr workspace + pi |
| `supervisor` | control | Supervisor (pi) | brain + tools |
| `reconcile` | control | Reconcile | FINAL_REPORTs + reviewer criteria |
| `busnode` | bus | A2A bus | run-details/.a2a-agent-bus.sock · JSONL · Zod · F1/F2 malformed |
| `peers` | bus | Peers (herdr panes) | permission-scoped tools |
| `budget` | bus | Budget | cost + token thresholds, OR'd |
| `writer` | artifacts | FinalWriter | final.md + findings.md |
| `record` | artifacts | run record | plan.md · conversation.jsonl · tool-calls.jsonl · .peer-*.json |

## Edges (10)

| id | From | To | Label | Flow class |
|---|---|---|---|---|
| `brief` | launcher | supervisor | opens | read (input/context) |
| `dispatch` | supervisor | busnode | dispatch_work_order / send_prompt | control |
| `workorder` | busnode | peers | WORK_ORDER / PROMPT | control |
| `report` | peers | busnode | FINAL_REPORT / RESPONSE | write (shared work) |
| `reports` | busnode | reconcile | reports | read |
| `threshold` | budget | supervisor | threshold | feedback (reviewed output) |
| `gate` | reconcile | writer | dod + criteria + run contract | control |
| `plan` | supervisor | record | plan.md | write |
| `toolcalls` | peers | record | tool-calls.jsonl | write |
| `deliver` | writer | record | final.md + findings.md | write |

## Legend (4 flow classes)

| flow | label |
|---|---|
| read | input / context |
| control | dispatch / control |
| write | shared work |
| feedback | reviewed output |

## Known transcription differences (small, semantic content identical)

Because each DSL is hand-written, wording varies slightly where a renderer's
label placement could not fit the canonical text:

| Edge / node | Variant used by |
|---|---|
| `dispatch` label | `dispatch_work_order / send_prompt` (mermaid, d2, graphviz, excalidraw, hand-svg) vs `dispatch / send_prompt` (fireworks) |
| `gate` label | `dod + criteria + run contract` (mermaid, d2, graphviz, hand-svg) vs `dod + criteria + contract` (excalidraw, fireworks) |
| `busnode` sub-label | `…JSONL · Zod · F1/F2 malformed` (mermaid) · `…JSONL · Zod · F1/F2` (graphviz) · `…JSONL · F1/F2` (fireworks) |
| `record` node | two-line label + sub-label (fireworks, hand-svg, excalidraw) vs one joined line (mermaid, d2, graphviz) |

If you standardise the diagrams later, edit the DSLs here and keep this table honest.
