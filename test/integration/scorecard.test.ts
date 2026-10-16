/**
 * Integration test: finalize with session.record_scorecard writes a parseable
 * run-details/scorecard.json and does not disturb final.md.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";
import { Runtime } from "../../src/runtime/runtime";
import { TAXONOMY_VERSION } from "../../src/scorecard/scorecard";

const fakeHerdr: HerdrClient = {
  createPane: async () => "p",
  runCommand: async () => {},
  reportMetadata: async () => {},
  closePane: async () => {},
};
const tick = () => new Promise((r) => setTimeout(r, 30));
const PASS = [{ criterion: "dod", result: "pass" as const, evidence: "verified" }];

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("scorecard finalize hook", () => {
  it("writes run-details/scorecard.json and it parses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-scorecard-"));
    dirs.push(dir);
    const config = parseSessionConfig({
      version: "1.1",
      session: {
        id: "s",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        attester: "peer1",
        record_scorecard: true,
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: [
        {
          id: "peer1",
          title: "P",
          model: "m/m",
          permissions: { read: true, edit: false, shell: false },
          max_cost_usd: 1,
          system_prompt: "sp",
        },
      ],
    });

    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    await writeFile(join(dir, "run-details", "plan.md"), "plan\n");
    const client = connect(rt.bus.path);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(
      `${JSON.stringify({
        id: "r1",
        timestamp: 0,
        sender: "peer1",
        recipient: "supervisor",
        type: "AGENT_REGISTER",
        payload: {
          agentId: "peer1",
          title: "P",
          model: "m/m",
          permissions: { read: true, edit: false, shell: false },
          maxCostUsd: 1,
          systemPrompt: "sp",
        },
      })}\n`,
    );
    await tick();

    await rt.finalize(true, undefined, undefined, PASS);

    const raw = await readFile(join(dir, "run-details", "scorecard.json"), "utf8");
    const scorecard = JSON.parse(raw) as { taxonomyVersion: string };
    expect(scorecard.taxonomyVersion).toBe(TAXONOMY_VERSION);

    // finalize outcome must be unchanged by the scorecard write.
    const finalMd = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(finalMd).toContain("exit_code: 0");

    client.destroy();
  });
});
