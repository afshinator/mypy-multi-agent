import { defineConfig } from "vite";
import { serverFilesystem } from "./server-middleware";

export default defineConfig({
  plugins: [serverFilesystem()],
  build: {
    outDir: "dist",
  },
});
