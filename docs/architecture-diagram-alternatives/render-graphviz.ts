import { instance } from "@viz-js/viz";
const viz = await instance();
const file = Bun.file(new URL("./graphviz-architecture.dot", import.meta.url));
const svg = viz.renderString(await file.text(), { format: "svg", engine: "dot", yInvert: false });
await Bun.write(new URL("./graphviz-architecture.svg", import.meta.url), svg);
console.log("graphviz ok", svg.length, "bytes");
