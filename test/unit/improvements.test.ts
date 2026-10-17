import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  measureImprovement,
  readImprovements,
  renderImprovements,
  writeImprovements,
} from "../../src/scorecard/improvements";
import type { RunScorecard } from "../../src/scorecard/scorecard";

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

const make = (mistakes: string[], taxonomyVersion = "1.0"): RunScorecard => ({
  ...base,
  taxonomyVersion,
  mistakes: mistakes.map((c) => ({ class: c as "M1" | "M2" | "M3", detail: "fixture" })),
});

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("measureImprovement", () => {
  it("names the target class and the scorecards before and after the change", () => {
    const ledger = [make(["M3"]), make(["M3", "M1"]), make([]), make([])];
    const report = measureImprovement({ change: "abc123", class: "M3", beforeCount: 2 }, ledger);

    expect(report.change).toBe("abc123");
    expect(report.class).toBe("M3");
    expect(report.before).toEqual({ scorecards: 2, count: 2, rate: 1 });
    expect(report.after).toEqual({ scorecards: 2, count: 0, rate: 0 });
    expect(report.delta).toBe(-1);
    expect(report.verdict).toBe("improved");
  });

  it("says not yet measurable when a side has no scorecards", () => {
    // No run has landed since the change.
    const noAfter = measureImprovement({ change: "#9", class: "M3", beforeCount: 1 }, [
      make(["M3"]),
    ]);
    expect(noAfter.after.scorecards).toBe(0);
    expect(noAfter.delta).toBeNull();
    expect(noAfter.verdict).toBe("not yet measurable");

    // Nothing before the change either.
    const noBefore = measureImprovement({ change: "#9", class: "M3", beforeCount: 0 }, [
      make(["M3"]),
    ]);
    expect(noBefore.verdict).toBe("not yet measurable");

    // An empty ledger has no taxonomy version to measure.
    const empty = measureImprovement({ change: "#9", class: "M3", beforeCount: 0 }, []);
    expect(empty.taxonomyVersion).toBeNull();
    expect(empty.verdict).toBe("not yet measurable");
  });

  it("reports a regression and an unchanged rate", () => {
    const regressed = measureImprovement({ change: "b2", class: "M3", beforeCount: 2 }, [
      make([]),
      make([]),
      make(["M3"]),
      make(["M3"]),
    ]);
    expect(regressed.delta).toBe(1);
    expect(regressed.verdict).toBe("regressed");

    const unchanged = measureImprovement({ change: "c3", class: "M3", beforeCount: 2 }, [
      make(["M3"]),
      make([]),
      make(["M3"]),
      make([]),
    ]);
    expect(unchanged.delta).toBe(0);
    expect(unchanged.verdict).toBe("unchanged");
  });

  it("never compares across taxonomy versions", () => {
    const ledger = [
      make(["M3"], "1.0"),
      make(["M3"], "1.0"),
      make([]),
      make(["M3"], "2.0"),
      make(["M3"], "2.0"),
    ];

    // Default version is the newest in the ledger, so the 1.0 prefix drops out.
    const newest = measureImprovement({ change: "d4", class: "M3", beforeCount: 2 }, ledger);
    expect(newest.taxonomyVersion).toBe("2.0");
    expect(newest.before.scorecards).toBe(0);
    expect(newest.verdict).toBe("not yet measurable");

    // Pinning 1.0 scopes both sides to 1.0 cards only.
    const pinned = measureImprovement(
      { change: "d4", class: "M3", beforeCount: 2, taxonomyVersion: "1.0" },
      ledger,
    );
    expect(pinned.before).toEqual({ scorecards: 2, count: 2, rate: 1 });
    expect(pinned.after).toEqual({ scorecards: 1, count: 0, rate: 0 });
    expect(pinned.delta).toBe(-1);
    expect(pinned.verdict).toBe("improved");
  });

  it("caps the after side at afterCount and tolerates an out-of-range beforeCount", () => {
    const ledger = [make(["M3"]), make(["M3"]), make([]), make([])];
    const capped = measureImprovement(
      { change: "e5", class: "M3", beforeCount: 2, afterCount: 3 },
      ledger,
    );
    expect(capped.after).toEqual({ scorecards: 1, count: 0, rate: 0 });

    const past = measureImprovement({ change: "e5", class: "M3", beforeCount: 99 }, ledger);
    expect(past.before.scorecards).toBe(4);
    expect(past.after.scorecards).toBe(0);
    expect(past.verdict).toBe("not yet measurable");
  });
});

describe("renderImprovements", () => {
  it("shows the delta per change, and says not yet measurable", () => {
    const md = renderImprovements([
      measureImprovement({ change: "abc123", class: "M3", beforeCount: 2 }, [
        make(["M3"]),
        make(["M3"]),
        make([]),
        make([]),
      ]),
      measureImprovement({ change: "#9", class: "M3", beforeCount: 1 }, [make(["M3"])]),
    ]);

    expect(md).toContain("| change | class | taxonomy | before | after | delta | verdict |");
    expect(md).toContain("| abc123 | M3 | 1.0 | 2/2 (1.000) | 0/2 (0.000) | -1.000 | improved |");
    expect(md).toContain("| #9 | M3 | 1.0 | 1/1 (1.000) | 0/0 (0.000) | - | not yet measurable |");
    expect(renderImprovements([])).toContain("No change records.");
  });
});

describe("readImprovements", () => {
  it("reads one record per line and skips malformed or invalid lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "improvements-"));
    dirs.push(dir);
    const path = join(dir, "improvements.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ change: "a1", class: "M3", beforeCount: 2 }),
        "{ not json",
        JSON.stringify({ change: "", class: "M3", beforeCount: 1 }),
        JSON.stringify({ change: "b2", beforeCount: 3 }),
        JSON.stringify({
          change: "c3",
          class: "M1",
          beforeCount: 3,
          afterCount: 5,
          taxonomyVersion: "2.0",
        }),
      ].join("\n"),
    );

    expect(await readImprovements(path)).toEqual([
      { change: "a1", class: "M3", beforeCount: 2 },
      { change: "c3", class: "M1", beforeCount: 3, afterCount: 5, taxonomyVersion: "2.0" },
    ]);
    expect(await readImprovements(join(dir, "missing.jsonl"))).toEqual([]);
  });
});

describe("writeImprovements", () => {
  it("measures a change against a synthetic before/after ledger on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "improvements-"));
    dirs.push(dir);
    const ledgerPath = join(dir, "ledger.jsonl");
    const recordsPath = join(dir, "improvements.jsonl");
    const outPath = join(dir, "improvements.md");

    const ledger = [make(["M3"]), make(["M3"]), make([]), make([])];
    await writeFile(ledgerPath, `${ledger.map((c) => JSON.stringify(c)).join("\n")}\n`);
    await writeFile(
      recordsPath,
      `${JSON.stringify({ change: "abc123", class: "M3", beforeCount: 2 })}\n`,
    );

    await writeImprovements(recordsPath, ledgerPath, outPath);

    const md = await readFile(outPath, "utf8");
    expect(md).toContain("| abc123 | M3 | 1.0 | 2/2 (1.000) | 0/2 (0.000) | -1.000 | improved |");
  });
});
