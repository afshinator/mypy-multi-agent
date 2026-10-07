/**
 * End-to-end acceptance test (real bus + herdr panes + model).
 * Skipped unless HERDR_ENV=1; asserts config -> bus -> panes -> work -> report -> final.md.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import { HerdrCliClient } from "../../src/herdr/herdr-client";

// Full end-to-end acceptance needs a live herdr session (HERDR_ENV=1) plus an
// authenticated model. Skipped otherwise. Runs the real bus + herdr panes +
// headless SDK peers against a real model; asserts the whole wiring chain
// (config -> bus -> panes -> registration -> work -> report -> final.md).
const inHerdr = process.env.HERDR_ENV === "1";
const E2E_MODEL = process.env.E2E_MODEL ?? "deepseek/deepseek-v4-pro";

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(!inHerdr)("end-to-end", () => {
  it("full run: config → bus → panes → registration → work → reports → final.md → exit 0", { timeout: 240_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-"));
    const config = parseSessionConfig({
      version: "1.1",
      session: { id: "e2e", max_cost_usd: 2, agent_stop_threshold_percent: 85 },
      ask: { title: "smoke", description: "live E2E smoke", definition_of_done: "peer replies E2E_OK" },
      agents: [
        {
          id: "worker",
          title: "Worker",
          model: E2E_MODEL,
          permissions: { read: true, edit: false, shell: false },
          max_cost_usd: 1,
          system_prompt: "You are a smoke-test worker. Reply only with the exact text requested.",
        },
      ],
    });

    const rt = new Runtime(dir, new HerdrCliClient(), config);
    try {
      await rt.start();
      await rt.spawnPeers();

      await waitFor(() => rt.registry.has("worker"), 30_000, "peer registration");

      expect(rt.dispatch("worker", {
        taskId: "t1",
        action: "Reply with exactly: E2E_OK",
        contextFiles: [],
        constraints: [],
        localDoD: "reply contains E2E_OK",
      })).toBe(true);

      await waitFor(() => rt.reconciliation.hasReport("worker"), 120_000, "FINAL_REPORT");

      const report = (rt.reconciliation.reports().get("worker")!.payload as { report: string }).report;
      expect(report).toContain("E2E_OK");

      await rt.finalize(true);
      const finalMd = await readFile(join(dir, "run-details", "final.md"), "utf8");
      expect(finalMd).toContain("exit_code: 0");
      expect(finalMd).toContain("E2E_OK");
    } finally {
      await rt.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
