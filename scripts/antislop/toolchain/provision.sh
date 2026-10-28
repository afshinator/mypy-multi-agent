#!/usr/bin/env bash
# Provision the pinned analyzer toolchain OUTSIDE every scanned tree.
#
#   ./provision.sh            # install + emit toolchain.json + log the run
#   ./provision.sh --verify   # re-check identity of an existing prefix; exit 3 on mismatch
#
# Audit agents never run this. It touches the network, so a human runs it before the
# session and the session only ever calls absolute paths recorded in toolchain.json.
#
# Two installers, one prefix: bun for the npm analyzers, uv for the Python ones
# (mypy/bandit/ruff are PyPI packages, not npm — see requirements.txt).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
prefix="${AUDIT_PREFIX:-$HOME/.audit/antislop}"
manifest="$here/manifest.ts"

if [ "${1:-}" = "--verify" ]; then
  exec bun "$manifest" "$prefix" --verify
fi

start="$(date +%s)"
mkdir -p "$prefix"
cp "$here/package.json" "$here/bun.lock" "$here/requirements.txt" "$prefix/"
# Lint profiles are copied, not imported from the repo, so their imports resolve against
# the pinned packages. The profile's hash goes into the audit artifact when it is used.
mkdir -p "$prefix/profiles"
cp "$here/profiles/"*.mjs "$prefix/profiles/"

# --ignore-scripts: no lifecycle hook runs. No hook was found on any pinned package,
# but the flag means a future version cannot add one unnoticed.
( cd "$prefix" && bun install --frozen-lockfile --ignore-scripts ) 2>&1 | tee "$prefix/install.log"

# Python analyzers. `uv venv` pins the interpreter so the three tools' behaviour does not
# drift with whatever python3 is first on PATH; `uv pip install` from a pinned file does
# not resolve versions. No lifecycle scripts exist for wheels, and --no-build runs nothing
# a wheel-less pin could compile (all three ship wheels for this host).
if [ -d "$prefix/python" ]; then rm -rf "$prefix/python"; fi
uv venv --python 3.12 "$prefix/python" 2>&1 | tee -a "$prefix/install.log"
uv pip install --python "$prefix/python/bin/python" -r "$prefix/requirements.txt" \
  2>&1 | tee -a "$prefix/install.log"

bun "$manifest" "$prefix"

cp "$prefix/toolchain.json" "$here/toolchain.json"

# Keep the committed artifact lint-clean without excluding it from `biome check`.
# Format the in-repo copy: biome refuses paths outside its project root.
repo_root="$(cd "$here/../../.." && pwd)"
if [ -x "$repo_root/node_modules/.bin/biome" ]; then
  "$repo_root/node_modules/.bin/biome" format --write "$here/toolchain.json" >/dev/null
fi
cp "$prefix/install.log" "$here/install.log"

elapsed="$(( $(date +%s) - start ))"
printf '%s\telapsed_s=%s\tprefix=%s\tlockfile_sha256=%s\n' \
  "$(date -u +%FT%TZ)" "$elapsed" "$prefix" "$(shasum -a 256 "$here/bun.lock" | cut -d' ' -f1)" \
  >> "$here/provisioning.log"

echo "provisioned in ${elapsed}s; manifest copied to $here/toolchain.json"
