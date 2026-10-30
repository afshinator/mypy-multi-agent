import { defineConfig } from "vitest/config";

// Mutation runs use the suite minus the one test that calls process.chdir(), which
// throws under the worker pool Stryker's coverage analysis requires. Per-module
// filtering is `vitest.related` in stryker.conf.json, not a test list here.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/unit/extension-launch.test.ts"],
  },
});
