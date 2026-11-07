/**
 * Integration test: finalize with session.record_scorecard writes a parseable
 * run-details/scorecard.json and does not disturb final.md.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import type { HerdrClient } from "../../src/herdr/herdr-client";
import { Runtime } from "../../src/runtime/runtime";
import { sanitizeScorecard } from "../../src/scorecard/collector";
import { type RunScorecard, TAXONOMY_VERSION } from "../../src/scorecard/scorecard";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

describe("scorecard in a workspace with no ledger", () => {
  it("writes the scorecard and creates no quality/ directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-noledger-"));
    dirs.push(dir);
    const config = parseSessionConfig({
      version: "1.1",
      session: {
        id: "s",
        max_cost_usd: 1,
        agent_stop_threshold_percent: 85,
        attester: "peer1",
        record_scorecard: true,
        workspace_root: dir,
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: [
        {
          id: "peer1",
          title: "P",
          model: "m/m",
          permissions: { read: true, edit: false, shell: false },
          max_cost_usd: 1,
          system_prompt: "p",
        },
      ],
    });

    const rt = new Runtime(dir, fakeHerdr, config);
    await rt.start();
    await writeFile(join(dir, "run-details", "plan.md"), "plan\n");

    // The private hook, because the failure this guards against is a throw: every batch
    // worktree has no quality/, so an append there fails and finalize logs it (#415).
    await (rt as unknown as { writeScorecard(): Promise<void> }).writeScorecard();

    expect(existsSync(join(dir, "quality"))).toBe(false);
    // The card itself still lands, since that is what `bun run collect` reads.
    expect(existsSync(join(dir, "run-details", "scorecard.json"))).toBe(true);
    await rt.stop();
  });
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
        workspace_root: dir,
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

    rt.gate.captureVerdicts("peer1", PASS);
    await rt.finalize(true);

    const raw = await readFile(join(dir, "run-details", "scorecard.json"), "utf8");
    const scorecard = JSON.parse(raw) as { taxonomyVersion: string } & Record<string, unknown>;
    expect(scorecard.taxonomyVersion).toBe(TAXONOMY_VERSION);

    // finalize outcome must be unchanged by the scorecard write.
    const finalMd = await readFile(join(dir, "run-details", "final.md"), "utf8");
    expect(finalMd).toContain("exit_code: 0");

    // The closing record moved (#163), not the artifacts: the frontmatter keeps the
    // key order and the scorecard keeps its field list, compared to the live run in
    // mypi-tasks/05-interpretation/run-details/ when it is present on this machine.
    const fixture = join(repoRoot, "mypi-tasks/05-interpretation/run-details");
    if (existsSync(join(fixture, "final.md"))) {
      // Top-level keys only: `agents:` repeats its children once per agent.
      const keys = (text: string) =>
        text
          .split("---")[1]!
          .split("\n")
          .filter((line) => /^[a-z_]+:/.test(line))
          .map((line) => line.split(":")[0]!.trim());
      expect(keys(finalMd)).toEqual(keys(await readFile(join(fixture, "final.md"), "utf8")));

      // Superset, not equality: that card is from Oct 20 and predates the fields
      // afcbe1f added (attester, conversation). Nothing may disappear from it.
      const fixtureCard = JSON.parse(
        await readFile(join(fixture, "scorecard.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(scorecard)).toEqual(expect.arrayContaining(Object.keys(fixtureCard)));
    }

    client.destroy();
  });

  it("appends exactly one sanitized line per run and leaves existing ledger lines intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-ledger-"));
    dirs.push(dir);

    const S_DECISION = "SENTINEL_DECISION_ledger";
    const S_EVIDENCE = "SENTINEL_EVIDENCE_ledger";
    const S_PROMPT = "SENTINEL_PROMPT_ledger";
    const criteria = [{ criterion: "dod", result: "pass" as const, evidence: S_EVIDENCE }];

    const config = parseSessionConfig({
      version: "1.1",
      session: {
        id: "s",
        max_cost_usd: 5,
        agent_stop_threshold_percent: 85,
        attester: "peer1",
        record_scorecard: true,
        workspace_root: dir,
      },
      ask: { title: "t", description: "d", definition_of_done: ["dod"] },
      agents: [
        {
          id: "peer1",
          title: "P",
          model: "m/m",
          permissions: { read: true, edit: false, shell: false },
          max_cost_usd: 1,
          system_prompt: S_PROMPT,
        },
      ],
    });

    const ledgerPath = join(dir, "quality", "ledger.jsonl");
    await mkdir(join(dir, "quality"), { recursive: true });
    const existing = ['{"marker":"first"}', '{"marker":"second"}'];
    await writeFile(ledgerPath, `${existing.join("\n")}\n`);

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
          systemPrompt: S_PROMPT,
        },
      })}\n`,
    );
    await tick();

    rt.gate.captureVerdicts("peer1", criteria);
    await rt.finalize(true, undefined, `decided to ${S_DECISION}`);

    const raw = await readFile(ledgerPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(existing[0]);
    expect(lines[1]).toBe(existing[1]);

    const line = JSON.parse(lines[2] ?? "{}") as RunScorecard & Record<string, unknown>;
    const written = JSON.parse(
      await readFile(join(dir, "run-details", "scorecard.json"), "utf8"),
    ) as RunScorecard;
    expect(line).toEqual(sanitizeScorecard(written));

    for (const key of [
      "prompt",
      "code",
      "transcript",
      "system-prompt",
      "decision",
      "evidence",
      "report",
    ]) {
      expect(line, key).not.toHaveProperty(key);
    }
    expect(lines[2]).not.toContain(S_DECISION);
    expect(lines[2]).not.toContain(S_EVIDENCE);
    expect(lines[2]).not.toContain(S_PROMPT);

    client.destroy();
  });
});
