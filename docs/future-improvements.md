# Future Improvements — portability + code-improvement tooling

Source of truth for planned changes to the multi-agent system. Items here get
promoted into `docs/TODO.md` (with TDD work orders) when we act on them.
Split deliberately into **system** (the multi-agent repo: orchestration,
harness, supervisor brain, tooling adapters) vs **task** (the `session.yaml` +
prompts that live in a task directory like `task-optimize-3/`).

## 1. Boundary: system vs task

| Concern | Owned by | Why |
|---|---|---|
| Launching the supervisor workspace (herdr + pi) | system | same on every repo; `bun run start` (was `just run`) |
| Bus, peers, budgets, lifecycle, extension | system | stack-agnostic already |
| Stack detection (JS/TS, Python, other) | system | one place to know what "test/build/lint" means |
| Analyzer availability + invocation (fallow, knip, semgrep, ruff, …) | system | adapters are generic; the supervisor just receives "available analyzers + their findings" |
| Supervisor brain (the loop) | system | generic orchestration |
| Ask, Definition of Done | task | the human intent per run |
| Roster / models / budgets | task | per-run cost/quality tradeoff |
| `validation.commands` (what "green" means) | task | derived from stack detection but stated per run |
| Which analyzers to actually run + thresholds | task | policy, not mechanism |
| Lint/format policy (biome/ruff/eslint) | task | repo convention |

## 2. The seams (what breaks portability)

Status (PORT-1, 2026-10-08): **S1–S5 resolved.** Correction to the original list:
only **S1 was a system seam.** S2–S5 were **task-level** facts (the shipped
example `task-optimize-N` configs), not system coupling — the system
(`src/` + `templates/`) never hardcoded fallow/`src/`/a diagram. The system's real
gaps were the launcher, missing stack detection, and a missing portable template.

- **S1 — launcher. FIXED.** Was: `just run` is a justfile recipe; repos without
  `just` can't start. Now: `src/pi/launch.ts` (`mypi-run [dir]` after `npm link`, or
  the script by absolute path); `bun run start`/`just run` stay in-repo aliases.
- **S2 — validation. FIXED (task side).** Was: `validation.commands` hardcoded
  `just test`/`just typecheck`/`git diff --check` — a task choice, not the system.
  Now: auto-filled from `detectStack` when scaffolding; the generic prompt's
  contract is "the task's `validation.commands` pass".
- **S3 — analyzers. FIXED.** Was: claimed "the supervisor prompt hardcodes
  `fallow health`/`fallow dead-code`" — it never did (verified across history);
  the coupling was in the example task. Now: `ANALYZER_CATALOG` in
  `src/stack/stack-profile.ts`, suggestions per detected language.
- **S4 — ask layout. FIXED.** Was: the example task said "read files as `src/...`".
  Now: `templates/portable.yaml` has no layout assumption.
- **S5 — findings diagram. FIXED / changed.** Was: the example task hardcoded a
  findings SVG (fireworks-tech-graph). Now: `findings.excalidraw` via the
  `excalidraw-diagram` skill; it is a task-owned artifact and never a DoD source
  (DoD = the `plan.md` ledger).

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

### P0 — make any-repo activation work — **done (PORT-1)**

1. **✅ Launcher without `just`.** Shipped as `src/pi/launch.ts` (`mypi-run [dir]`
   bin, or the script by absolute path; `bun run start` in-repo only) — a port of
   the `just run` herdr bootstrap. Not extension-driven: the
   extension cannot re-exec itself into a new workspace, so the bootstrap stays a
   script. `just run` remains an alias.
2. **✅ Stack detection.** `src/stack/stack-profile.ts` — `detectStack(dir)` over
   `package.json` scripts (bun/npm), `pyproject.toml`/`requirements.txt`/
   `setup.py`, `Cargo.toml`, `go.mod`, with `Makefile`/`justfile` fallback; plus
   `ANALYZER_CATALOG` + `describeAnalyzers`.
3. **✅ Generic portable template.** `templates/portable.yaml` — stack-neutral ask
   + roster, no `src/`, no fallow, no fixed validation.
4. **✅ Supervisor prompt — stack-neutral.** The run contract is "the task's
   `validation.commands` pass"; the supervisor detects the repo's own commands
   when none are declared.
5. **✅ Validation auto-fill.** `src/pi/scaffold.ts` writes `session.yaml` from the
   portable template with `validation.commands` from `detectStack` (never
   overwrites an existing file).

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

1. ✅ P0 items 1–5 — shipped as PORT-1 (2026-10-08); see `docs/TODO.md`.
2. P1 items 6–8 (JS/TS + Python best-practice analyzers) — next.
3. P2 as demand appears.

Known gaps from PORT-1: the analyzer catalog suggests ids but does not probe
whether a tool is installed; the portable template ships placeholder model slugs;
and the launcher is a script, not extension-driven.
