import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregate } from "../../src/scorecard/aggregate";
import type { RunScorecard } from "../../src/scorecard/scorecard";
import { renderTrends, writeTrends } from "../../src/scorecard/trends";

const base: RunScorecard = {
  taxonomyVersion: "1.0",
  outcome: "success",
  exitCode: 0,
  outcomeExitMismatch: false,
  dod: "met",
  falseSuccess: false,
  turnDurationsMs: {},
  toolTimeMs: 0,
  toolTimeByAgentMs: {},
  toolCalls: 0,
  toolErrors: 0,
  retries: 0,
  correlationTimeouts: 0,
  agentCrashed: 0,
  agentUnusable: 0,
  agentStalled: 0,
  stopAgentReasons: {},
  cost: {
    totalCostUsd: null,
    totalTokens: null,
    supervisorCostUsd: null,
    supervisorTokens: null,
    agents: [],
  },
  modelRoster: [],
  mistakes: [],
};

const make = (over: Partial<RunScorecard> = {}): RunScorecard => ({
  ...base,
  ...over,
  cost: { ...base.cost, ...(over.cost ?? {}) },
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("trends", () => {
  it("renders the worst offender first", () => {
    const trends = aggregate([
      make({
        mistakes: [
          { class: "M1", detail: "a" },
          { class: "M2", detail: "b" },
        ],
      }),
      make({ mistakes: [{ class: "M1", detail: "c" }] }),
    ]);
    const md = renderTrends(trends);
    expect(md.indexOf("| M1 ")).toBeGreaterThan(-1);
    expect(md.indexOf("| M1 ")).toBeLessThan(md.indexOf("| M2 "));
  });

  it("prints the attestation rounds, which no mistake class can carry", () => {
    const trends = aggregate([
      make({ attestationRounds: 11, firstAttestationRoundFailed: true }),
      make({ attestationRounds: 2, firstAttestationRoundFailed: false }),
    ]);
    const md = renderTrends(trends);
    expect(md).toContain(
      "Attestation rounds: mean 6.500 over 2 card(s), 1 with a failed first round.",
    );
  });

  it("omits the line when no card carries the metric", () => {
    expect(renderTrends(aggregate([make({})]))).not.toContain("Attestation rounds");
  });

  it("writeTrends writes trends.md from ledger.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trends-"));
    dirs.push(dir);
    const ledger = join(dir, "ledger.jsonl");
    await writeFile(
      ledger,
      `${JSON.stringify(make({ mistakes: [{ class: "M1", detail: "a" }] }))}\n`,
    );
    const out = join(dir, "trends.md");

    await writeTrends(ledger, out);
    const md = await readFile(out, "utf8");
    expect(md).toContain("# Quality trends");
    expect(md).toContain("| M1 |");
  });
});
