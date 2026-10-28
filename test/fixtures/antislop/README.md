# Anti-slop normalizer fixtures

Sliced from real reporter output captured on this repository at `9f9ca93` during the
toolchain dry run (arrays trimmed to two entries each, `knip` reduced to issues that
carry a finding). They exist so the normalizers are tested against shapes the tools
actually emit, not invented JSON.

`tsc.txt` is the exception: this repository typechecks clean, so no real `tsc`
diagnostic existed to capture. Those two lines use tsc's documented text format.

`biome.json` is named `biome-report.json` because Biome treats any file called
`biome.json` as its own configuration.

The three Python fixtures (`mypy.jsonl`, `bandit.json`, `ruff.json`) were captured from the
pinned `mypy` 2.4.0, `bandit` 1.9.4 and `ruff` 0.17.3 in the audit prefix on 2026-10-28,
against a two-function fixture file. `mypy.jsonl` is deliberately kept line-delimited: that
is the shape `--output json` emits, and a test asserts the whole stream is not one JSON
document.

The three fallow reports are named `dead-code.json`, `dupes.json`, `health.json`
because `.gitignore` has a `fallow-*` pattern for analyzer artifacts.
