# Architecture diagram — renderer comparison

The same architecture, drawn six ways by six generators, to compare output
quality and tool weight on identical input.

## The single source of content

**One source:** [`spec.md`](spec.md) — the canonical node/edge/label set (3
containers, 8 nodes, 10 edges, 4 legend classes).

That spec was derived by reading the **current implementation** (`src/runtime/runtime.ts`,
`src/pi/extension.ts`, `src/pi/launch.ts`, `src/bus/*`, `src/peer/peer-config.ts`,
`src/validation/run-contract.ts`, `src/budget/*`, plus `README.md` and
`docs/agent-config-guide.md`). The previously committed `docs/architecture.json`
was **not** used — it described the pre-PORT, pre-I1/I2 architecture and has been
deleted.

Each generator has its own DSL file, and every DSL is a **hand transcription of
`spec.md`** — there is no build step linking them, so they can drift. Known minor
wording differences are listed at the bottom of `spec.md`.

## The six renderings

| # | Tool | Source file | Rendered output | Style |
|---|---|---|---|---|
| 1 | fireworks-tech-graph (Style 1 Flat Icon) | `fireworks-architecture.json` | `fireworks-architecture.svg` / `.png` | semantic arrow colors, legend, footer |
| 2 | Mermaid (+ mermaid-cli) | `mermaid-architecture.mmd` | `mermaid-architecture.svg` / `.png` | default theme, subgraph bands |
| 3 | D2 | `d2-architecture.d2` | `d2-architecture.svg` / `.png` | flat blue containers |
| 4 | Graphviz (`dot`) | `graphviz-architecture.dot` | `graphviz-architecture.svg` / `.png` | record clusters, rounded boxes |
| 5 | Excalidraw | `excalidraw-architecture.excalidraw` | `excalidraw-architecture.png` | hand-drawn, editable canvas |
| 6 | Hand-authored SVG | `hand-svg-architecture.svg` | `hand-svg-architecture.png` | flat, manually routed |

## Cost per tool

Render time is **measured** (`bench.py`, median of 3 runs, this machine, no model
involved). Source size is the emitted DSL file. "Authoring revisions" is how many
model write/iterate cycles each diagram needed before it was acceptable — the
number of times I had to change the source after seeing the render.

| Tool | Render (median) | Runtime dependency | Layout produced by | Model needed for layout | Authoring revisions | Source size |
|---|---|---|---|---|---|---|
| **D2** | **20 ms** | one Go binary (`d2`, brew) | bundled dagre/elk/tala | none | 1 (ids + `direction: down`) | 29 lines / 976 B |
| **Graphviz** | **36 ms** | `@viz-js/viz` WASM via bun | `dot` | none (ranking tuned by hand) | 3 (cluster + row fixes) | 52 lines / 1.9 KB |
| **fireworks-tech-graph** | 1 423 ms | Python 3 + skill scripts | internal router | none at render, config tuned by hand | 7 (mode arg, 2 label collisions, truncation, profile, headroom) | 1 line / 5.2 KB (JSON) |
| **Mermaid** | 1 650 ms | `npx @mermaid-js/mermaid-cli` + headless Chromium | dagre (JS) | none | 1 (clean first render) | 25 lines / 946 B |
| **Excalidraw** | 2 102 ms | `npx @excalidraw-skill-pack/render` + Chromium | **manual** (hand-placed) | yes — all coordinates | 4 (arrows, label layout) | 46 lines / 6.7 KB |
| **Hand-authored SVG** | 0 ms (no render step) | none | **manual** | yes — all coordinates + routing | 3 (2 rewrites + label fixes) | 108 lines / 5.6 KB |

To PNG (all SVG variants): `rasterize.ts` + `trim.py`, **5 508 ms total** for all
five SVGs via headless Chromium (see `bench.json`). That dominates every render time, so if PNG
output matters, `brew install librsvg` (or `pip install cairosvg`) makes
`fireworks.py export-png` work and drops that to milliseconds. Mermaid and
Excalidraw still need Chromium regardless.

## Model cost (estimate)

No renderer calls a model. The model cost is **authoring only, paid once**. The
numbers below are estimates, not measurements: emitted source tokens
(bytes ÷ 4, measured) × (1 + authoring revisions) × 2 for reasoning/iteration.
Treat them as ±2×.

| Tool | Emitted tokens (measured) | Est. authoring total |
|---|---|---|
| Mermaid | ~236 | **~1 k** |
| D2 | ~244 | **~1.5 k** |
| Graphviz | ~485 | **~4 k** |
| Hand-authored SVG | ~1 402 | **~11 k** |
| Excalidraw | ~1 665 | **~17 k** |
| fireworks-tech-graph | ~1 288 | **~21 k** |

A fixed discovery cost (reading the code to derive `spec.md`) is shared by all six
and is not included above. The takeaway is the ordering: **auto-layout tools cost
~1–4 k tokens to author; manual-layout tools cost ~11–17 k**, and fireworks cost
the most despite auto-layout because its router needed the most correction.

## Determinism and CI fit

This is the axis that matters if you want to avoid the model entirely.

| Tool | Render deterministic | LLM at render time | Runs offline | Diff-friendly source | Fits CI |
|---|---|---|---|---|---|
| D2 | yes | no | yes | yes (text) | **best** — single binary, 20 ms |
| Graphviz | yes | no | yes (WASM) | yes (text) | **best** — no native binary needed |
| Mermaid | yes | no | yes (Chromium must be present) | yes (text) | good |
| fireworks-tech-graph | yes | no | yes | yes (JSON) | good |
| Excalidraw | yes | no | yes (Chromium must be present) | poor (hand-placed coords) | weak — layout is manual |
| Hand-authored SVG | yes (it is the asset) | no | yes | poor (hand-placed coords) | weakest — every edit is manual |

**D2 is the standout for model-free, deterministic generation:** it is a single
self-contained Go executable with all three layout engines bundled (`dagre`,
`elk`, `tala` — no Node, no helper process, no browser), renders in 20 ms, and
produced a clean layout from a 29-line source after a single correction.

## Observed tradeoffs

| Tool | Strengths | Weaknesses (as rendered here) |
|---|---|---|
| **D2** | cleanest container grouping; shortest source; fastest render; zero manual routing | container order is chosen by the engine (bus on the left, not under control) |
| **Mermaid** | clean auto-layout; renders natively on GitHub with no build step; worked first try | default cream theme; least compact aspect ratio (portrait) |
| **Graphviz** | mature cluster model; predictable rows | needs `rank=same` + `constraint=false` to behave; `threshold` exits to the right margin and returns; least attractive defaults |
| **fireworks-tech-graph** | most polished house style (semantic arrow colors, legend, footer); the `docs/architecture.svg` toolchain | noisiest routing of the six: 24 bends, `plan.md` leaves the container and runs down the margin, `dod + criteria + contract` label far from its edge; the most authoring revisions; `quality_profile: "showcase"` rejects this graph outright |
| **Excalidraw** | only artifact that stays editable in a canvas (Obsidian/VS Code); nice typography | no auto-layout — long cross-band edges are hand-routed; busiest result |
| **Hand-authored SVG** | exact control over corridors, margins, label placement; no dependencies | every coordinate and route maintained by hand; no engine to lean on |

## Rating checklist

Useful when comparing the images side by side:

1. **Routing** — crossings, bends, any line leaving its container or crossing a
   label. (D2 best; fireworks worst here.)
2. **Label placement** — is each edge label near its own edge and legible?
3. **Grouping fidelity** — do the three bands read as Control / Bus·Peers / Artifacts?
4. **Aspect ratio** — the images differ; Mermaid is portrait, D2 ~1:1, Graphviz
   and the hand-SVG are landscape. Matters for embedding in Markdown.
5. **Diff-ability** — text DSLs (`mmd`, `d2`, `dot`) review cleanly in git;
   `.excalidraw` and hand-SVG do not.
6. **A11y** — the fireworks generator does **not** emit a `<title>`, so a
   regenerated SVG drops it and re-fails biome's `noSvgWithoutTitle`
   (`task-optimize-7/run-details/findings.md:68`). The hand-SVG has one by hand.
7. **Styling** — legend/colors/footer (fireworks richest), theme neutrality
   (Mermaid cream, D2/hand-svg flat).

## Review

Per-diagram verdicts (yours to fill in):

| # | Tool | Verdict | Notes |
|---|---|---|---|
| 1 | fireworks-tech-graph | | |
| 2 | Mermaid | | |
| 3 | D2 | | |
| 4 | Graphviz | | |
| 5 | Excalidraw | | |
| 6 | Hand-authored SVG | | |

## Regenerate

```sh
cd docs/architecture-diagram-alternatives

# 1 fireworks-tech-graph (first arg must match the JSON's "mode": "agent")
SK=/Users/afshin/.pi/agent/skills/fireworks-tech-graph/scripts/fireworks.py
python3 "$SK" validate agent fireworks-architecture.json
python3 "$SK" render agent fireworks-architecture.json fireworks-architecture.svg --report fireworks-layout.json
python3 "$SK" check fireworks-architecture.svg

# 2 Mermaid (reuses a Playwright Chromium; skip puppeteer's own download)
PUPPETEER_SKIP_DOWNLOAD=1 npx -y @mermaid-js/mermaid-cli@11 \
  -i mermaid-architecture.mmd -o mermaid-architecture.svg -p pptr.json -b white

# 3 D2
d2 --theme 0 --pad 20 d2-architecture.d2 d2-architecture.svg

# 4 Graphviz (WASM)
#    @viz-js/viz is NOT a dependency of this repo — installing it here walks up
#    and edits the root package.json. Revert that after rendering.
bun add @viz-js/viz@3 && bun render-graphviz.ts && git checkout ../../../package.json ../../../bun.lock

# 5 Excalidraw (edit the .excalidraw skeleton, then re-render)
npx -y @excalidraw-skill-pack/render excalidraw-architecture.excalidraw

# 6 hand-svg-architecture.svg is edited directly

# PNG previews for the SVG variants, then re-measure
bun rasterize.ts && python3 trim.py
python3 bench.py
```

`pptr.json` (Mermaid) points puppeteer at the Playwright Chromium; recreate it if
missing:

```json
{ "executablePath": "~/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  "args": ["--no-sandbox"] }
```

Helper scripts: `render-graphviz.ts` (WASM render), `rasterize.ts` (SVG→PNG via
headless Chromium), `trim.py` (PIL whitespace trim), `bench.py` (timings →
`bench.json`).
