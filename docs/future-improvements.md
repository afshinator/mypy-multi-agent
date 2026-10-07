# Future Improvements — portability + code-improvement tooling

Source of truth for planned changes to the multi-agent system. Items here get
promoted into `docs/TODO.md` (with TDD work orders) when we act on them.
Split deliberately into **system** (the multi-agent repo: orchestration,
harness, supervisor brain, tooling adapters) vs **task** (the `session.yaml` +
prompts that live in a task directory like `task-optimize-3/`).

## 1. Boundary: system vs task

| Concern | Owned by | Why |
|---|---|---|
| Launching the supervisor workspace (herdr + pi) | system | same on every repo; `just run` today is a system concern leaked into the repo |
| Bus, peers, budgets, lifecycle, extension | system | stack-agnostic already |
| Stack detection (JS/TS, Python, other) | system | one place to know what "test/build/lint" means |
| Analyzer availability + invocation (fallow, knip, semgrep, ruff, …) | system | adapters are generic; the supervisor just receives "available analyzers + their findings" |
| Supervisor brain (the loop) | system | generic orchestration |
| Ask, Definition of Done | task | the human intent per run |
| Roster / models / budgets | task | per-run cost/quality tradeoff |
| `validation.commands` (what "green" means) | task | derived from stack detection but stated per run |
| Which analyzers to actually run + thresholds | task | policy, not mechanism |
| Lint/format policy (biome/ruff/eslint) | task | repo convention |

## 2. The seams (what breaks portability today)

- **S1 — launcher.** `just run` is a justfile recipe; repos without `just` can't start.
- **S2 — validation.** `validation.commands` hardcodes `just test`/`just typecheck`/`git diff --check` (JS/TS + just).
- **S3 — fallow.** The supervisor prompt hardcodes `fallow health`/`fallow dead-code` (JS/TS only).
- **S4 — ask layout.** The ask says "read files as `src/...`" (assumes a layout).
- **S5 — findings SVG.** The ask hardcodes a "fallow-findings" SVG; should be a generic findings/architecture diagram.

## 3. Tool evaluation (from the 2026-10-07 summary + Python additions)

### 3.1 Generic (language-agnostic)

- **Semgrep** — AST structural search + security/pattern/anti-pattern rules; MCP server or CLI `--json`. *Primary generic analyzer.* Works for JS/TS, Python, and most languages.
- **GritQL** — structural AST transforms / slop removal, polyglot; CLI JSON. Good for "delete this pattern everywhere" work.
- **Trivy** — secrets, dependency, IaC, CVE scanning; CLI JSON. On-demand security pass, not every run.
- **SonarQube/SonarLint (`sonar-scanner`)** — multi-lang quality, cognitive complexity, duplication; SARIF/JSON. Heavy; only useful when the repo already uses it or needs hard metric thresholds.

### 3.2 JS/TS

- **Fallow** — keep as baseline: dead code, unreachable exports, unused deps, circular imports, clones, complexity. Already a skill here.
- **Knip** — unused files/deps/exports, monorepo-aware. *Best complement to fallow for dead code.* CLI `--reporter json`.
- **jscpd** — copy/paste duplication with coordinates + similarity. CLI `--reporters json`.
- **Biome** — Rust lint + format + import sort, near-zero config, JSON diagnostics. *Default for agent workflows + new repos.*
- **ESLint v9 (flat config)** — keep for existing enterprise repos with plugin needs.
- **Oxlint** — fast basic correctness checks, run alongside ESLint for heavy type-aware rules.

### 3.3 Python (proposed — not in the summary, added for the "JS/TS + Python" goal)

- **Ruff** — fast lint + format (the Python analogue of Biome); `ruff check --output-format json`.
- **mypy** (or **pyright**) — type checking.
- **pytest** — test runner (detect and use for `validation.commands`).
- Semgrep covers Python security/patterns; SonarQube covers Python complexity.

### 3.4 Recommendation matrix

| Stack | Analyze (findings) | Dead code / deps | Lint + format | Tests (validation) |
|---|---|---|---|---|
| JS/TS | fallow + semgrep | fallow + knip | biome (default) / eslint v9 (enterprise) | package.json scripts |
| Python | semgrep + ruff | semgrep (unused imports/vars) | ruff | pytest |
| other | semgrep (+ sonar if present) | semgrep | repo's own | repo's own |

## 4. Recommendations

Tagged **[SYS]** = multi-agent repo change; **[TASK]** = `session.yaml`/prompt change.

### P0 — make any-repo activation work

1. **[SYS] Launcher in the extension.** Move the `just run` bootstrap (herdr workspace + `pi`) into the extension so `/mypi-multi-agent` starts the supervisor workspace itself. Removes the `just` hard-dependency (S1).
2. **[SYS] Stack detection.** Add a small module that probes `package.json` / `pyproject.toml` / `requirements*.txt` / `Cargo.toml` / `go.mod` / `Makefile` / `justfile` and returns a `StackProfile` (language, test/build/lint commands, whether fallow applies).
3. **[TASK] Generic portable template.** A `templates/portable.yaml` with a stack-neutral ask ("review, improve, and comment this repository, section by section; changes on a branch, not merged") and no `src/`, no fallow, no fixed validation (S4, S5).
4. **[TASK] Supervisor prompt — analyzers optional.** Replace the hardcoded `fallow health/dead-code` step with: "use any of the available analyzers listed in the briefing; if none apply, inspect the repo directly (tree, README, build files, existing tests) to partition the work." (S3).
5. **[SYS→TASK] Validation auto-fill.** `validation.commands` derived from the `StackProfile` and written into the generated `session.yaml`; empty for repos with no standard build (S2).

### P1 — analyzer depth (JS/TS + Python)

6. **[SYS] Analyzer registry.** A small adapter table: `detect(dir) -> available`, `run(dir) -> JSON findings`, one entry each for fallow, knip, semgrep, jscpd, biome, ruff, mypy. The supervisor briefing lists only the detected ones; every one is optional (fallback = direct inspection). Kills the fallow hard-dependency structurally.
7. **[TASK] Tool selection + thresholds.** A `session.yaml` section (or prompt directive) letting a run name which analyzers to invoke and any thresholds (e.g. "complexity > 15", "knip unused must be 0"). Policy stays in the task.
8. **[TASK] Lint/format as a gate.** For code-changing runs, run biome/ruff as a validation step (replaces the JS/TS-only `just test`/`typecheck` pair).

### P2 — later, only if needed

9. **[SYS] MCP adapters.** Semgrep (and fallow) via MCP instead of CLI `--json`. Defer: CLI JSON is sufficient and simpler for v1.
10. **[SYS] Trivy security pass.** Optional on-demand security scan, not part of the default loop.
11. **[SYS] GritQL transforms.** Optional "apply this structural cleanup everywhere" tool.
12. **[SYS] SonarQube metrics.** Only for repos that already run it; otherwise skip (heavy).

## 5. Order of work

1. P0 items 1–5 (unblock any-repo activation; no stack knowledge beyond detect).
2. P1 items 6–8 (JS/TS + Python best-practice analyzers).
3. P2 as demand appears.
