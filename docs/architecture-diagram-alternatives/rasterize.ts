import { rm } from "node:fs/promises";
// Rasterizes each rendered SVG to a tight PNG for side-by-side inspection.
// The browser's pt/px handling differs per emitter (Graphviz uses pt, Mermaid
// uses %), so render into a generously oversized window and trim the whitespace
// with PIL afterwards rather than guessing the exact canvas.
const CHROME = "/Users/afshin/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium";
const targets = ["mermaid-architecture.svg", "d2-architecture.svg", "graphviz-architecture.svg", "hand-svg-architecture.svg", "fireworks-architecture.svg"];
const SCALE = 2;

for (const svg of targets) {
  const txt = await Bun.file(svg).text();
  const vb = /viewBox="([\d.\-\s]+)"/.exec(txt)?.[1]?.trim().split(/\s+/).map(Number);
  const w = (vb ? Math.ceil(vb[2]) : 1400) * SCALE + 400;
  const h = (vb ? Math.ceil(vb[3]) : 900) * SCALE + 400;
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}</style>${txt.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "")}`;
  const tmp = `.raster-${svg.replace(/\.svg$/, "")}.html`;
  await Bun.write(tmp, html);
  const out = svg.replace(/\.svg$/, ".png");
  const p = Bun.spawnSync([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
    `--force-device-scale-factor=${SCALE}`, `--window-size=${w},${h}`,
    `--screenshot=${out}`, `file://${process.cwd()}/${tmp}`], { stdout: "pipe", stderr: "pipe" });
  await rm(tmp, { force: true });
  console.log(svg, "->", out, p.exitCode === 0 ? "ok" : "FAIL");
}
