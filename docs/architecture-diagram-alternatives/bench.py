#!/usr/bin/env python3
"""Times each renderer (no model involved) — median of 3 runs.

Prerequisites: pptr.json (Mermaid), `bun add @viz-js/viz@3` (Graphviz),
and the cached Playwright Chromium that pptr.json points at.
    python3 bench.py
"""
import subprocess, time, statistics, os, shutil, json, sys

SK = "/Users/afshin/.pi/agent/skills/fireworks-tech-graph/scripts/fireworks.py"
cwd = os.path.dirname(os.path.abspath(__file__))
env = dict(os.environ, PUPPETEER_SKIP_DOWNLOAD="1", PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="1")

shutil.copy(f"{cwd}/excalidraw-architecture.excalidraw", "/tmp/bench-exc.excalidraw")

CASES = {
    "fireworks (python)":            ["python3", SK, "render", "agent", "fireworks-architecture.json", "/tmp/bench-fw.svg"],
    "mermaid (npx + chromium)":      ["npx", "-y", "@mermaid-js/mermaid-cli@11", "-i", "mermaid-architecture.mmd", "-o", "/tmp/bench-mm.svg", "-p", "pptr.json", "-b", "white"],
    "d2 (go binary)":                ["d2", "--theme", "0", "--pad", "20", "d2-architecture.d2", "/tmp/bench-d2.svg"],
    "graphviz (bun + wasm)":         ["bun", "render-graphviz.ts"],
    "excalidraw (npx + chromium)":   ["npx", "-y", "@excalidraw-skill-pack/render", "/tmp/bench-exc.excalidraw"],
    "rasterize svg->png (chromium)": ["bun", "rasterize.ts"],
}


def main() -> int:
    results = {}
    for name, cmd in CASES.items():
        runs = []
        for _ in range(3):
            start = time.perf_counter()
            subprocess.run(cmd, cwd=cwd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            runs.append((time.perf_counter() - start) * 1000)
        results[name] = round(statistics.median(runs))
        print(f"{name:34s} median {results[name]:6d} ms   runs={[round(r) for r in runs]}")
    json.dump(results, open(f"{cwd}/bench.json", "w"), indent=2)
    print("\nwrote bench.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
